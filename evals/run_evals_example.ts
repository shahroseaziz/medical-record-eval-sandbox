/**
 * evals/run_evals_example.ts — Example eval gate
 *
 * Runs every case in src/example/eval-example.json through the real two-call
 * faithfulness judge using the example's stored judgeRubric — the SAME
 * parameterized verdict path /api/score hits when a user supplies a custom
 * rubric. A runtime regression that would break user evals is caught here.
 *
 * Baseline scoping: reads only src/example/eval-example.json (a committed
 * artifact). Browser-local user eval data is structurally unreachable from CI.
 *
 * Checks:
 *   1. eval-example.json carries >=1 disagreement row
 *   2. API liveness (Voyage + Claude)
 *   3. Each case scores without a judge error (faithfulness)
 *   4. Pass cases score above the example's threshold
 *   5. structured-diff runtime: a valid fixture scores in [0,1]; a no-expected
 *      fixture degrades to errored (never crash)
 *   6. reference-judge runtime: a live verdict is valid + non-errored; a malformed
 *      judge response surfaces "errored", never a crash or fabricated verdict (E13)
 *
 * Exit codes:
 *   0  gate-green
 *   1  gate-red  (hard failure)
 *   2  gate-inconclusive  (Claude or Voyage temporarily down)
 *
 * Usage: npx tsx evals/run_evals_example.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scoreFaithfulness } from '../src/lib/eval/scorers/faithfulness.js'
import { scoreStructuredDiff } from '../src/lib/eval/scorers/structured-diff.js'
import { scoreReferenceJudge } from '../src/lib/eval/scorers/reference-judge.js'
import { isUpstreamOutage, EXPECTED_JUDGE_MODEL, EXPECTED_EMBEDDING_MODEL } from './run_evals.js'
import { checkJudgePromptParity } from './harness/prompt-hash.js'
import type {
  EvalCase,
  FaithfulnessResult,
  StructuredDiffResult,
  ReferenceJudgeResult,
  ReferenceVerdict,
} from '../src/lib/eval/types.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname, '..')
export const EXAMPLE_PATH = join(REPO_ROOT, 'src/example/eval-example.json')

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_PROBE_TIMEOUT_MS = 20_000
const ANTHROPIC_PROBE_TIMEOUT_MS = 15_000

export const EXIT_GREEN = 0
export const EXIT_RED = 1
export const EXIT_INCONCLUSIVE = 2

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GateViolation {
  check: string
  message: string
}

export type GateStatus = 'green' | 'red' | 'inconclusive'

export interface GateResult {
  status: GateStatus
  violations: GateViolation[]
  inconclusiveReason?: string
}

export interface ExampleGateOptions {
  anthropicClient?: Anthropic
  voyageProber?: (apiKey: string) => Promise<'ok' | 'down'>
  anthropicProber?: () => Promise<'ok' | 'down'>
  examplePath?: string
  scoreFn?: (evalCase: EvalCase, client?: Anthropic, rubric?: string) => Promise<FaithfulnessResult>
  /** Override the structured-diff scorer (deterministic, free); defaults to the real one. */
  structuredDiffFn?: (evalCase: EvalCase, actual?: unknown) => StructuredDiffResult
  /**
   * Override the LIVE reference-judge scorer used for the positive fixture only;
   * defaults to the real one. The malformed negative fixture ALWAYS uses the real
   * scoreReferenceJudge against an in-process client (no live tokens) so the
   * errored-not-faked path is genuinely exercised.
   */
  referenceJudgeFn?: (
    actual: string,
    expected: string,
    client?: Anthropic,
    options?: { criteria?: string; maxTokens?: number },
  ) => Promise<ReferenceJudgeResult>
}

interface ExampleChunk {
  text: string
  section: string
  distance?: number
  similarity?: number
}

interface ExampleCase {
  id: string
  taskPrompt: string
  patientId: string
  ragMode: 'retrieve' | 'stuff'
  capturedOutput: string
  capturedGrounding?: {
    mode: string
    chunks?: ExampleChunk[]
  }
  intentLabel: 'pass' | 'fail'
}

interface ExampleResult {
  caseId: string
  intentLabel: 'pass' | 'fail'
  faithfulnessScore: number
  zeroClaimFlag?: boolean
}

interface ExampleData {
  judgeRubric: string
  threshold: number
  cases: ExampleCase[]
  results: ExampleResult[]
}

// ── New-scorer runtime fixtures (R14) ──────────────────────────────────────────
//
// The faithfulness path above is the original gate. R14 also guards the two
// scorers added in the correctness-first redesign — structured-diff (free,
// deterministic) and reference-judge (live Haiku) — so a runtime regression in
// either is caught here, not in production.

const REFERENCE_VERDICTS = new Set<ReferenceVerdict>(['equivalent', 'partial', 'divergent'])

/**
 * Structured-diff fixture: a hand-authored expected med list vs an actual list
 * with one deliberate dose mismatch (Atorvastatin 20mg → 40mg). A correct scorer
 * returns a finite F1 in [0,1] with at least one mismatch — never `errored`.
 */
export const STRUCTURED_DIFF_FIXTURE: { evalCase: EvalCase; actual: unknown } = {
  evalCase: {
    id: 'r14-structured-diff-runtime',
    patientId: 'example-fixture',
    query: 'List documented medications with dose.',
    output:
      '{"medications":[{"name":"Lisinopril","dose":"10 mg"},{"name":"Atorvastatin","dose":"40 mg"}]}',
    mode: 'retrieve',
    expectedStructured: {
      medications: [
        { name: 'Lisinopril', dose: '10 mg' },
        { name: 'Atorvastatin', dose: '20 mg' },
      ],
    },
  },
  actual: {
    medications: [
      { name: 'Lisinopril', dose: '10 mg' },
      { name: 'Atorvastatin', dose: '40 mg' },
    ],
  },
}

/**
 * Structured-diff negative fixture: no `expectedStructured` on the case. The
 * scorer must degrade to `errored` with a null score — never crash or fabricate
 * a confusion matrix from nothing.
 */
export const STRUCTURED_DIFF_NEGATIVE: { evalCase: EvalCase; actual: unknown } = {
  evalCase: {
    id: 'r14-structured-diff-negative',
    patientId: 'example-fixture',
    query: 'List documented medications.',
    output: '{"medications":[]}',
    mode: 'retrieve',
  },
  actual: undefined,
}

/** Reference-judge fixture: prose that should read as equivalent meaning to a live judge. */
export const REFERENCE_JUDGE_FIXTURE = {
  actual: 'The patient takes Lisinopril 10mg daily and Atorvastatin 20mg at night.',
  expected: 'Patient is on Lisinopril 10mg once daily and Atorvastatin 20mg nightly.',
}

/** Reference-judge negative fixture: any prose pair — the malformed JUDGE response is what forces errored. */
export const REFERENCE_JUDGE_NEGATIVE = {
  actual: 'Patient takes Lisinopril.',
  expected: 'Patient takes Lisinopril 10mg daily.',
}

/**
 * An in-process Anthropic stub whose verdict tool always returns an enum value
 * OUTSIDE the valid set {equivalent, partial, divergent}. Feeding this to the
 * real scoreReferenceJudge drives its parse-reject → retry → null → errored path
 * deterministically, with zero live tokens. This is the regression guard for the
 * E13 contract: a malformed reference-judge case must surface `errored: true`
 * with a null verdict — never a crash, never a fabricated verdict.
 *
 * NEVER used for the positive live call.
 */
function makeMalformedJudgeClient(): Anthropic {
  return {
    messages: {
      create: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'reference_verdict',
            input: { verdict: 'MALFORMED_NOT_IN_ENUM', reason: 'injected malformed verdict' },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    },
  } as unknown as Anthropic
}

// ── Exported check helpers (unit-testable) ────────────────────────────────────

/**
 * A disagreement row exists when the stored judge score disagrees with the
 * case's intentLabel:
 *   - intentLabel=fail, faithfulnessScore >= threshold (judge incorrectly passes)
 *   - intentLabel=pass, faithfulnessScore < threshold  (judge incorrectly fails)
 *
 * The example must contain at least one such row to illustrate judge imperfection.
 */
export function checkDisagreementRows(
  results: ExampleResult[],
  threshold: number
): GateViolation | null {
  const hasDisagreement = results.some(
    (r) =>
      (r.intentLabel === 'fail' && r.faithfulnessScore >= threshold) ||
      (r.intentLabel === 'pass' && r.faithfulnessScore < threshold)
  )
  if (!hasDisagreement) {
    return {
      check: 'disagreement-row',
      message:
        'eval-example.json has no disagreement row (a case where the stored judge score ' +
        'disagrees with intentLabel) — the example must illustrate judge imperfection.',
    }
  }
  return null
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function probeVoyage(apiKey: string): Promise<'ok' | 'down'> {
  try {
    const resp = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: ['example-gate-probe'],
        model: EXPECTED_EMBEDDING_MODEL,
        input_type: 'query',
        output_dimension: 1024,
      }),
      signal: AbortSignal.timeout(VOYAGE_PROBE_TIMEOUT_MS),
    })
    if (resp.status >= 500) return 'down'
    return 'ok'
  } catch {
    return 'down'
  }
}

async function probeAnthropic(client: Anthropic): Promise<'ok' | 'down'> {
  try {
    await Promise.race([
      client.messages.create({
        model: EXPECTED_JUDGE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('ETIMEDOUT: Claude probe timeout')),
          ANTHROPIC_PROBE_TIMEOUT_MS
        )
      ),
    ])
    return 'ok'
  } catch (err) {
    if (isUpstreamOutage(err)) return 'down'
    return 'ok'
  }
}

function log(msg: string): void {
  process.stdout.write(msg + '\n')
}

function ok(msg: string): void {
  log(`  OK    ${msg}`)
}

function fail(msg: string): void {
  log(`  FAIL  ${msg}`)
}

// ── Main gate ─────────────────────────────────────────────────────────────────

export async function runExampleGate(opts: ExampleGateOptions = {}): Promise<GateResult> {
  const violations: GateViolation[] = []

  function add(v: GateViolation | null): void {
    if (v) {
      violations.push(v)
      fail(v.message)
    }
  }

  const examplePath = opts.examplePath ?? EXAMPLE_PATH

  // [0] Judge-prompt template parity (O11/E28f) — a silent template edit re-rolls
  // every score while judgeModel still matches; cheap + deterministic, so it runs
  // before any live call.
  const promptDrift = checkJudgePromptParity()
  for (const msg of promptDrift) add({ check: 'prompt-parity', message: msg })
  if (promptDrift.length === 0) ok('judge prompt templates match committed hashes (E28f)')

  // [1] Load example artifact
  if (!existsSync(examplePath)) {
    return {
      status: 'red',
      violations: [
        {
          check: 'example-exists',
          message: `eval-example.json not found at ${examplePath}.`,
        },
      ],
    }
  }

  const exampleData: ExampleData = JSON.parse(readFileSync(examplePath, 'utf-8'))

  log('\n[1] Disagreement-row assertion (>=1 required)')
  add(checkDisagreementRows(exampleData.results, exampleData.threshold))
  if (violations.length === 0) {
    const count = exampleData.results.filter(
      (r) =>
        (r.intentLabel === 'fail' && r.faithfulnessScore >= exampleData.threshold) ||
        (r.intentLabel === 'pass' && r.faithfulnessScore < exampleData.threshold)
    ).length
    ok(`${count} disagreement row(s) present — judge imperfection illustrated`)
  }

  if (violations.length > 0) {
    return { status: 'red', violations }
  }

  // [2] Env checks
  const voyageKey = process.env.VOYAGE_API_KEY
  if (!voyageKey) {
    return {
      status: 'red',
      violations: [{ check: 'env', message: 'VOYAGE_API_KEY env var is required.' }],
    }
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return {
      status: 'red',
      violations: [{ check: 'env', message: 'ANTHROPIC_API_KEY env var is required.' }],
    }
  }

  const client = opts.anthropicClient ?? new Anthropic({ apiKey: anthropicKey })

  // [3] API liveness probes
  log('\n[2] API liveness probes (Voyage + Claude)')

  const voyageStatus = await (opts.voyageProber ?? probeVoyage)(voyageKey)
  if (voyageStatus === 'down') {
    log('  INCONCLUSIVE  Voyage AI liveness probe failed')
    return {
      status: 'inconclusive',
      violations: [],
      inconclusiveReason: 'Voyage AI appears to be down (liveness probe timed out or returned 5xx).',
    }
  }
  ok('Voyage AI responding')

  const claudeProbe = opts.anthropicProber ?? (() => probeAnthropic(client))
  const claudeStatus = await claudeProbe()
  if (claudeStatus === 'down') {
    log('  INCONCLUSIVE  Claude API liveness probe failed')
    return {
      status: 'inconclusive',
      violations: [],
      inconclusiveReason: 'Claude API appears to be down (liveness probe failed).',
    }
  }
  ok('Claude API responding')

  // [4] Run each case through the parameterized verdict path
  //
  // scoreFaithfulness is called with the example's judgeRubric — the same code path
  // /api/score hits when a user supplies a custom rubric. Any runtime regression in
  // the parameterized verdict flow breaks this gate.
  log('\n[3] Example cases through parameterized verdict path')

  const runScore = opts.scoreFn ?? scoreFaithfulness

  for (const exCase of exampleData.cases) {
    log(`\n  case: ${exCase.id} (intentLabel=${exCase.intentLabel})`)

    const chunks = (exCase.capturedGrounding?.chunks ?? []).map((c) => ({
      section: c.section,
      text: c.text,
    }))

    const evalCase: EvalCase = {
      id: exCase.id,
      patientId: exCase.patientId,
      query: exCase.taskPrompt,
      output: exCase.capturedOutput,
      mode: 'retrieve',
      retrievedChunks: chunks,
      k: chunks.length,
    }

    const result = await runScore(evalCase, client, exampleData.judgeRubric)

    if (result.errored) {
      add({
        check: 'judge-error',
        message: `Case ${exCase.id}: judge errored — ${result.errorMessage ?? 'unknown'}`,
      })
      continue
    }

    ok(
      `Case ${exCase.id}: score=${(result.score ?? 0).toFixed(4)} claims=${result.claims.length}`
    )

    if (exCase.intentLabel === 'pass' && (result.score ?? 0) < exampleData.threshold) {
      add({
        check: 'pass-case-below-threshold',
        message:
          `Case ${exCase.id} (intentLabel=pass): score=${(result.score ?? 0).toFixed(4)} ` +
          `< threshold=${exampleData.threshold}`,
      })
    }
  }

  // [4] Structured-diff scorer runtime path (deterministic, client-side / free)
  //
  // Exercises scoreStructuredDiff — the per-field reference diff /api/score-reference
  // hits when a user grades a structured field. A valid fixture must produce a
  // finite F1 score; a no-expected fixture must degrade to errored, never crash.
  log('\n[4] Structured-diff scorer runtime path')

  const runStructuredDiff = opts.structuredDiffFn ?? scoreStructuredDiff

  const sd = runStructuredDiff(STRUCTURED_DIFF_FIXTURE.evalCase, STRUCTURED_DIFF_FIXTURE.actual)
  if (sd.errored) {
    add({
      check: 'structured-diff-runtime',
      message: `structured-diff errored on a valid fixture — ${sd.errorMessage ?? 'unknown'}`,
    })
  } else if (typeof sd.score !== 'number' || sd.score < 0 || sd.score > 1) {
    add({
      check: 'structured-diff-runtime',
      message: `structured-diff produced a non-[0,1] score: ${String(sd.score)}`,
    })
  } else {
    ok(
      `structured-diff fixture: score=${sd.score.toFixed(4)} ` +
        `match=${sd.matchCount} mismatch=${sd.mismatchCount} missing=${sd.missingCount} extra=${sd.extraCount}`,
    )
  }

  const sdNeg = runStructuredDiff(STRUCTURED_DIFF_NEGATIVE.evalCase, STRUCTURED_DIFF_NEGATIVE.actual)
  if (!sdNeg.errored || sdNeg.score !== null) {
    add({
      check: 'structured-diff-negative',
      message:
        `structured-diff on a no-expected fixture must be errored with a null score; ` +
        `got errored=${String(sdNeg.errored)} score=${String(sdNeg.score)}`,
    })
  } else {
    ok('structured-diff negative fixture: errored (null score) — degraded, not crashed')
  }

  // [5] Reference-judge scorer runtime path
  //
  // Positive: a live Haiku verdict (Claude liveness already confirmed in [2]) must
  // return a valid verdict, not errored — the same path /api/score-reference runs.
  // Negative: a deliberately-malformed judge response must drive the REAL scorer to
  // `errored` — never a crash, never a fabricated verdict (the E13 contract).
  log('\n[5] Reference-judge scorer runtime path')

  const runReferenceJudge = opts.referenceJudgeFn ?? scoreReferenceJudge

  const rj = await runReferenceJudge(
    REFERENCE_JUDGE_FIXTURE.actual,
    REFERENCE_JUDGE_FIXTURE.expected,
    client,
  )
  if (rj.errored) {
    add({
      check: 'reference-judge-runtime',
      message: `reference-judge errored on a valid fixture — ${rj.errorMessage ?? 'unknown'}`,
    })
  } else if (rj.verdict == null || !REFERENCE_VERDICTS.has(rj.verdict)) {
    add({
      check: 'reference-judge-runtime',
      message: `reference-judge returned no valid verdict: ${String(rj.verdict)}`,
    })
  } else {
    ok(`reference-judge fixture: verdict=${rj.verdict} score=${(rj.score ?? 0).toFixed(2)}`)
  }

  // Reference-EFFECT pair (O11/E28a — the cycle's motivating defect as a live gate
  // check): the SAME output scored against a deliberately divergent reference must
  // score strictly lower than against the matching reference. If an authored
  // reference ever stops reaching the scorer again (pitfall #15786), this fails.
  if (opts.referenceJudgeFn) {
    ok('reference-effect: skipped under injected judge (live-path check only — the wiring half is pinned by the O4 unit test)')
  } else {
  const rjDivergent = await runReferenceJudge(
    REFERENCE_JUDGE_FIXTURE.actual,
    'The patient takes warfarin 5mg twice daily and has no other medications.',
    client,
  )
  if (rjDivergent.errored || rjDivergent.score == null || rj.score == null) {
    add({
      check: 'reference-effect',
      message: `reference-effect pair could not be scored (divergent errored=${String(rjDivergent.errored)})`,
    })
  } else if (rjDivergent.score >= rj.score) {
    add({
      check: 'reference-effect',
      message:
        `reference-effect violated: divergent reference scored ${rjDivergent.score.toFixed(2)} >= ` +
        `matching ${rj.score.toFixed(2)} — the authored reference is not driving the score (E28a)`,
    })
  } else {
    ok(`reference-effect: matching=${rj.score.toFixed(2)} > divergent=${rjDivergent.score.toFixed(2)} — the reference drives the score`)
  }
  }

  // Negative fixture — runs the REAL scoreReferenceJudge against an in-process
  // malformed-response client (no live tokens), so the errored-not-faked path is
  // exercised end-to-end even when the live gate is dispatched.
  const rjNeg = await scoreReferenceJudge(
    REFERENCE_JUDGE_NEGATIVE.actual,
    REFERENCE_JUDGE_NEGATIVE.expected,
    makeMalformedJudgeClient(),
  )
  if (!rjNeg.errored || rjNeg.score !== null || rjNeg.verdict !== null) {
    add({
      check: 'reference-judge-negative',
      message:
        `malformed reference-judge case must be errored with a null score & verdict (E13); ` +
        `got errored=${String(rjNeg.errored)} score=${String(rjNeg.score)} verdict=${String(
          rjNeg.verdict,
        )}`,
    })
  } else {
    ok(
      'reference-judge negative fixture: errored (null score & verdict) — not a crash, not a fabricated verdict',
    )
  }

  if (violations.length === 0) {
    return { status: 'green', violations: [] }
  }
  return { status: 'red', violations }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('┌─────────────────────────────────────────────────────────────┐')
  log('│  example eval gate  —  evals/run_evals_example.ts           │')
  log('└─────────────────────────────────────────────────────────────┘')

  const result = await runExampleGate()

  log('\n══════════════════════════════════════════════════════════════')
  if (result.status === 'green') {
    log('  ✓  gate-green: all checks passed')
    process.exit(EXIT_GREEN)
  } else if (result.status === 'inconclusive') {
    log(`  ~  gate-inconclusive (upstream down): ${result.inconclusiveReason ?? ''}`)
    log('     Re-run when Claude/Voyage recovers.')
    process.exit(EXIT_INCONCLUSIVE)
  } else {
    log(`  ✗  gate-red: ${result.violations.length} violation(s)`)
    for (const v of result.violations) {
      log(`       [${v.check}] ${v.message}`)
    }
    process.exit(EXIT_RED)
  }
}

const _isMain = fileURLToPath(import.meta.url) === process.argv[1]
if (_isMain) {
  main().catch((err: Error) => {
    console.error('[example-gate] Unexpected error:', err)
    process.exit(EXIT_RED)
  })
}
