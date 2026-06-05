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
 *   3. Each case scores without a judge error
 *   4. Pass cases score above the example's threshold
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
import { isUpstreamOutage, EXPECTED_JUDGE_MODEL, EXPECTED_EMBEDDING_MODEL } from './run_evals.js'
import type { EvalCase, FaithfulnessResult } from '../src/lib/eval/types.js'

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
