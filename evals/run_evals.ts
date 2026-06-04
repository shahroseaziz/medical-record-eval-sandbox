/**
 * evals/run_evals.ts — Build-time eval quality gate
 *
 * Runs the real two-call faithfulness judge against stored baseline outputs.
 * Never mocks the judge.  Outage detection covers both Claude and Voyage.
 *
 * Checks:
 *   1. Model equality guards (judgeModel + embeddingModel must match constants)
 *   2. judge_kappa_min floor from thresholds.yaml
 *   3. BYO-key grep (no hardcoded API keys in src/)
 *   4. Per-case score reproduction: |fresh_mean - baseline_mean| ≤ max(0.05, 3·stddev)
 *   5. Off-band invariant (in-band seed case guard)
 *   6. Under-extraction guard (zeroClaimFlag on a seeded case → fail)
 *   7. Contains determinism (same input → identical result both runs)
 *   8. 6 MB section_hit required pass (all Agustin437 retrieve cases)
 *   9. Aggregate passRate EXACT (same pass count as baseline)
 *
 * Exit codes:
 *   0  gate-green
 *   1  gate-red  (hard failure)
 *   2  gate-inconclusive  (Claude or Voyage is currently down)
 *
 * Usage: npx tsx evals/run_evals.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseCcda } from '../src/lib/ccda/index.js'
import { scoreFaithfulness } from '../src/lib/eval/scorers/faithfulness.js'
import { scoreContains } from '../src/lib/eval/scorers/contains.js'
import { scoreSectionHit } from '../src/lib/eval/scorers/section-hit.js'
import { computeMeanScore } from '../src/lib/eval/aggregate.js'
import { loadThresholds } from '../src/lib/eval/thresholds.js'
import type { EvalCase, FaithfulnessResult } from '../src/lib/eval/types.js'

// ── Constants ─────────────────────────────────────────────────────────────────

export const EXPECTED_JUDGE_MODEL = 'claude-haiku-4-5-20251001'
export const EXPECTED_EMBEDDING_MODEL = 'voyage-3.5'

const FAITHFULNESS_GATE_RUNS = 3   // fewer than baseline's k for speed; tolerance band absorbs variance
const ANTHROPIC_PROBE_TIMEOUT_MS = 15_000

const REPO_ROOT = join(import.meta.dirname, '..')
const BASELINE_PATH = join(REPO_ROOT, 'evals/results/seed-baseline.json')
const CASES_PATH = join(REPO_ROOT, 'evals/golden/seed-cases.json')
const THRESHOLDS_PATH = join(REPO_ROOT, 'evals/thresholds.yaml')
const FIXTURE_DIR = join(REPO_ROOT, 'src/lib/ccda/__fixtures__')
const SRC_DIR = join(REPO_ROOT, 'src')

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_PROBE_TIMEOUT_MS = 20_000

export const EXIT_GREEN = 0
export const EXIT_RED = 1
export const EXIT_INCONCLUSIVE = 2

// ── Types ─────────────────────────────────────────────────────────────────────

interface SeedCase {
  id: string
  taskPrompt: string
  patientId: string
  ragMode: 'retrieve' | 'stuff'
  expectedOutput: string
  referenceLabel: 'pass' | 'fail'
  requiredSections?: string[]
  expectedClaims?: string[]
  preauthoredOutput?: string
  rationale: string
  scorers: string[]
}

interface BaselineScorerResult {
  scorer: string
  score: number | null
  zeroClaimFlag?: boolean
}

interface BaselineCase {
  caseId: string
  trace: {
    output: string
    retrievedChunks?: Array<{ section: string; text: string }>
  }
  scorerResults: BaselineScorerResult[]
  meanScore: number | null
  scoreStdDev: number | null
  referenceLabel: 'pass' | 'fail'
}

interface BaselineAggregate {
  passRate: number | null
  n: number
  note: string
  judgeHumanKappa?: number | null
}

interface BaselineData {
  judgeModel: string
  embeddingModel: string
  k: number
  cases: BaselineCase[]
  aggregate: BaselineAggregate
}

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

export interface GateOptions {
  /** Override for dependency injection in tests */
  anthropicClient?: Anthropic
  /** Override Voyage liveness probe for tests */
  voyageProber?: (apiKey: string) => Promise<'ok' | 'down'>
  /** Override Claude liveness probe for tests */
  anthropicProber?: () => Promise<'ok' | 'down'>
  /** Override baseline path for tests */
  baselinePath?: string
  /** Override seed-cases path for tests */
  casesPath?: string
  /** Override thresholds path for tests */
  thresholdsPath?: string
}

// ── Exported check helpers (unit-testable) ────────────────────────────────────

export function checkModelGuards(
  baseline: Pick<BaselineData, 'judgeModel' | 'embeddingModel'>,
  expectedJudge: string,
  expectedEmbedding: string
): GateViolation | null {
  if (baseline.judgeModel !== expectedJudge) {
    return {
      check: 'model-guard',
      message:
        `Judge model mismatch: baseline="${baseline.judgeModel}" expected="${expectedJudge}" — ` +
        'model swap detected; regenerate baseline with the correct model.',
    }
  }
  if (baseline.embeddingModel !== expectedEmbedding) {
    return {
      check: 'embedding-guard',
      message:
        `Embedding model mismatch: baseline="${baseline.embeddingModel}" expected="${expectedEmbedding}" — ` +
        'model swap detected; regenerate baseline with the correct model.',
    }
  }
  return null
}

export function checkKappaFloor(
  aggregate: BaselineAggregate,
  kappaMin: number
): GateViolation | null {
  const kappa = aggregate.judgeHumanKappa
  if (kappa === undefined) {
    return {
      check: 'kappa-floor',
      message:
        'judgeHumanKappa absent from baseline aggregate — run npm run compute:kappa before committing baseline.',
    }
  }
  if (kappa === null) {
    return {
      check: 'kappa-floor',
      message:
        'judgeHumanKappa is null — could not be computed; check evals/golden/human-labels.json.',
    }
  }
  if (kappa < kappaMin) {
    return {
      check: 'kappa-floor',
      message:
        `judge_kappa_min floor breach: judgeHumanKappa=${kappa.toFixed(4)} < ${kappaMin} (threshold from thresholds.yaml).`,
    }
  }
  return null
}

export function checkScoreTolerance(
  caseId: string,
  freshMean: number,
  baselineMean: number,
  baselineStdDev: number
): GateViolation | null {
  const tolerance = Math.max(0.05, 3 * baselineStdDev)
  const delta = Math.abs(freshMean - baselineMean)
  if (delta > tolerance) {
    return {
      check: 'score-tolerance',
      message:
        `Case ${caseId}: freshMean=${freshMean.toFixed(4)} baseline=${baselineMean.toFixed(4)} ` +
        `delta=${delta.toFixed(4)} > tolerance=±${tolerance.toFixed(4)} (max(0.05, 3·${baselineStdDev.toFixed(6)})).`,
    }
  }
  return null
}

export function checkInBand(
  caseId: string,
  score: number,
  referenceLabel: 'pass' | 'fail',
  threshold: number
): GateViolation | null {
  if (referenceLabel === 'pass' && score <= threshold) {
    return {
      check: 'in-band',
      message:
        `Case ${caseId} (referenceLabel=pass): score=${score.toFixed(4)} ≤ threshold=${threshold} — ` +
        'in-band; off-band invariant violated.',
    }
  }
  if (referenceLabel === 'fail' && score >= threshold) {
    return {
      check: 'in-band',
      message:
        `Case ${caseId} (referenceLabel=fail): score=${score.toFixed(4)} ≥ threshold=${threshold} — ` +
        'in-band; off-band invariant violated.',
    }
  }
  return null
}

export function checkUnderExtraction(
  caseId: string,
  zeroClaimFlag: boolean
): GateViolation | null {
  if (zeroClaimFlag) {
    return {
      check: 'under-extraction',
      message:
        `Case ${caseId}: faithfulness judge extracted 0 claims from a seeded output — ` +
        'under-extraction detected; judge or extraction prompt may be broken.',
    }
  }
  return null
}

export function checkPassRateExact(
  freshPassCount: number,
  freshN: number,
  baselinePassRate: number | null,
  baselineN: number
): GateViolation | null {
  if (freshN !== baselineN) {
    return {
      check: 'passrate-exact',
      message: `Aggregate n mismatch: fresh=${freshN} baseline=${baselineN}.`,
    }
  }
  if (baselinePassRate === null) return null
  const baselinePassCount = Math.round(baselinePassRate * baselineN)
  if (freshPassCount !== baselinePassCount) {
    const freshRate = freshN > 0 ? (freshPassCount / freshN).toFixed(4) : 'N/A'
    return {
      check: 'passrate-exact',
      message:
        `Aggregate passRate mismatch: fresh=${freshPassCount}/${freshN}=${freshRate} ` +
        `baseline=${baselinePassCount}/${baselineN}=${baselinePassRate.toFixed(4)}.`,
    }
  }
  return null
}

/** Returns a violation if hardcoded API key patterns are found in source files. */
export function checkBYOKeyGrep(srcDir: string): GateViolation | null {
  // Patterns that should never appear in committed source (literal key prefixes)
  const KEY_PATTERNS: RegExp[] = [
    /sk-ant-api\d{2}-[A-Za-z0-9_-]{10,}/,     // Anthropic secret key
    /Bearer\s+sk-ant-api\d{2}-[A-Za-z0-9_-]{5,}/, // Anthropic key in auth header
    /pa-[A-Za-z0-9_-]{30,}/,                   // Voyage AI API key
  ]

  const tsFiles = walkTsFiles(srcDir)
  for (const file of tsFiles) {
    const content = readFileSync(file, 'utf-8')
    for (const pattern of KEY_PATTERNS) {
      if (pattern.test(content)) {
        return {
          check: 'byo-key-grep',
          message: `Hardcoded API key detected in ${file} — keys must be injected via env vars, never committed.`,
        }
      }
    }
  }
  return null
}

/** True when the error indicates Claude or Voyage is temporarily unavailable (not a code bug). */
export function isUpstreamOutage(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  // Anthropic SDK: connection-level failure (DNS, TCP, TLS, timeout)
  if (error instanceof Anthropic.APIConnectionError) return true

  // Anthropic SDK: HTTP 5xx (including 529 overloaded) — InternalServerError subclass
  if (error instanceof Anthropic.InternalServerError) return true

  // Raw network error strings (from fetch-based Voyage calls or Node network stack)
  const msg = String((error as Error).message ?? '')
  if (
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('fetch failed') ||
    /voyage api error (5\d\d)/i.test(msg)
  ) {
    return true
  }

  return false
}

// ── Private helpers ───────────────────────────────────────────────────────────

function walkTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.next') {
      results.push(...walkTsFiles(full))
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      results.push(full)
    }
  }
  return results
}

const _fixtureCache = new Map<string, string>()

function getPatientRecordText(patientId: string): string {
  if (_fixtureCache.has(patientId)) return _fixtureCache.get(patientId)!
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.xml'))
  for (const file of files) {
    const xml = readFileSync(join(FIXTURE_DIR, file), 'utf-8')
    const result = parseCcda(xml)
    if (result.patientId === patientId) {
      const text = result.sections
        .map((s) => `[${s.section.toUpperCase()}]\n${s.text}`)
        .join('\n\n---\n\n')
      _fixtureCache.set(patientId, text)
      return text
    }
  }
  throw new Error(`Patient ${patientId} not found in ${FIXTURE_DIR}`)
}

async function probeVoyage(apiKey: string): Promise<'ok' | 'down'> {
  try {
    const resp = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        input: ['gate-probe'],
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
    // Non-outage errors (auth, bad-request) mean the API is reachable
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

// ── Main gate orchestrator ────────────────────────────────────────────────────

export async function runGate(opts: GateOptions = {}): Promise<GateResult> {
  const violations: GateViolation[] = []

  function add(v: GateViolation | null): void {
    if (v) {
      violations.push(v)
      fail(v.message)
    }
  }

  const baselinePath = opts.baselinePath ?? BASELINE_PATH
  const casesPath = opts.casesPath ?? CASES_PATH
  const thresholdsPath = opts.thresholdsPath ?? THRESHOLDS_PATH

  // ── Load artifacts ───────────────────────────────────────────────────────────

  if (!existsSync(baselinePath)) {
    const v: GateViolation = {
      check: 'baseline-exists',
      message: `seed-baseline.json not found at ${baselinePath} — run npm run generate:baseline first.`,
    }
    return { status: 'red', violations: [v] }
  }

  const baseline: BaselineData = JSON.parse(readFileSync(baselinePath, 'utf-8'))
  const seedCases: SeedCase[] = JSON.parse(readFileSync(casesPath, 'utf-8'))
  const thresholds = loadThresholds(thresholdsPath)

  const seedCaseMap = new Map<string, SeedCase>(seedCases.map((sc) => [sc.id, sc]))

  // ── [1] Static checks — fail fast before any API call ────────────────────────

  log('\n[1] Model equality guards')
  add(checkModelGuards(baseline, EXPECTED_JUDGE_MODEL, EXPECTED_EMBEDDING_MODEL))
  if (violations.length === 0) ok(`judgeModel="${EXPECTED_JUDGE_MODEL}" embeddingModel="${EXPECTED_EMBEDDING_MODEL}"`)

  log('\n[2] judge_kappa_min floor')
  add(checkKappaFloor(baseline.aggregate, thresholds.judgeKappaMin))
  if (violations.length === 0) {
    ok(
      `judgeHumanKappa=${(baseline.aggregate.judgeHumanKappa as number).toFixed(4)} ≥ judge_kappa_min=${thresholds.judgeKappaMin}`
    )
  }

  log('\n[3] BYO-key grep (no hardcoded API keys in src/)')
  add(checkBYOKeyGrep(SRC_DIR))
  if (violations.length === 0) ok('No hardcoded API keys detected in src/')

  if (violations.length > 0) {
    log(`\ngate-red: ${violations.length} static check(s) failed — aborting before API calls.`)
    return { status: 'red', violations }
  }

  // ── [4] API liveness probes (Voyage + Claude) ───────────────────────────────

  log('\n[4] API liveness probes (Voyage + Claude)')

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

  // ── [5-9] Live judge scoring ─────────────────────────────────────────────────

  log('\n[5] Per-case live judge scoring')

  let freshPassCount = 0
  let freshN = 0

  for (const bc of baseline.cases) {
    const sc = seedCaseMap.get(bc.caseId)
    if (!sc) {
      add({
        check: 'case-missing',
        message: `Baseline case "${bc.caseId}" not found in seed-cases.json.`,
      })
      continue
    }

    log(`\n  case: ${bc.caseId} (referenceLabel=${bc.referenceLabel})`)

    const hasFaithfulness = sc.scorers.includes('faithfulness')
    const hasContains = sc.scorers.includes('contains')
    const hasSectionHit = sc.scorers.includes('section-hit')

    // Build grounding context from baseline trace (no re-retrieval needed)
    const grounding: Pick<EvalCase, 'mode' | 'retrievedChunks' | 'record'> =
      sc.ragMode === 'retrieve'
        ? { mode: 'retrieve', retrievedChunks: bc.trace.retrievedChunks ?? [] }
        : { mode: 'stuff', record: getPatientRecordText(sc.patientId) }

    const evalCase: EvalCase = {
      id: bc.caseId,
      patientId: sc.patientId,
      query: sc.taskPrompt,
      output: bc.trace.output,
      expectedOutput: sc.expectedOutput,
      requiredSections: sc.requiredSections,
      k: baseline.k,
      ...grounding,
    }

    // ── [5a] Contains determinism test ──────────────────────────────────────
    if (hasContains) {
      const r1 = scoreContains(evalCase)
      const r2 = scoreContains(evalCase)
      const deterministic =
        r1.score === r2.score && r1.missingItems.join('|') === r2.missingItems.join('|')
      if (!deterministic) {
        add({
          check: 'contains-determinism',
          message: `Case ${bc.caseId}: contains scorer produced different results on two identical calls.`,
        })
      } else {
        ok(`contains determinism ✓ score=${r1.score}`)
      }
    }

    // ── [5b] 6 MB section_hit required pass ─────────────────────────────────
    if (hasSectionHit && sc.ragMode === 'retrieve') {
      const hitResult = scoreSectionHit(evalCase)
      if (hitResult.score !== 1) {
        add({
          check: 'section-hit-required',
          message:
            `Case ${bc.caseId}: section_hit=${hitResult.score}, ` +
            `missing=[${hitResult.missingSections.join(', ')}], ` +
            `retrieved=[${hitResult.retrievedSections.join(', ')}].`,
        })
      } else {
        ok(`section-hit ✓ required=[${(sc.requiredSections ?? []).join(', ')}]`)
      }
    }

    // ── [5c] Live faithfulness judge ─────────────────────────────────────────
    if (!hasFaithfulness) continue

    // scoreFaithfulness swallows all API exceptions internally; detect mid-run outage
    // by re-probing Claude whenever a result comes back errored.
    const freshResults: FaithfulnessResult[] = []
    let caseErrored = false
    for (let i = 0; i < FAITHFULNESS_GATE_RUNS; i++) {
      const r = await scoreFaithfulness(evalCase, client)
      if (r.errored) {
        const recheck = opts.anthropicProber ?? (() => probeAnthropic(client))
        if (await recheck() === 'down') {
          log('  INCONCLUSIVE  Claude API went down during scoring')
          return {
            status: 'inconclusive',
            violations: [],
            inconclusiveReason: `Claude API failed mid-run (run ${i + 1}/${FAITHFULNESS_GATE_RUNS}): ${r.errorMessage ?? 'unknown error'}`,
          }
        }
        add({
          check: 'judge-error',
          message: `Case ${bc.caseId}: judge returned errored result (run ${i + 1}): ${r.errorMessage ?? 'unknown'}`,
        })
        caseErrored = true
        break
      }
      freshResults.push(r)
    }
    if (caseErrored) continue

    const allZero = freshResults.every((r) => r.zeroClaimFlag)
    const freshMean = computeMeanScore(freshResults)

    // Under-extraction guard
    add(checkUnderExtraction(bc.caseId, allZero))

    if (!allZero && freshMean !== null) {
      ok(`freshMean=${freshMean.toFixed(4)} (${FAITHFULNESS_GATE_RUNS} runs)`)

      // Score tolerance
      if (bc.meanScore !== null) {
        const v = checkScoreTolerance(bc.caseId, freshMean, bc.meanScore, bc.scoreStdDev ?? 0)
        add(v)
        if (!v) {
          ok(
            `within tolerance ±${Math.max(0.05, 3 * (bc.scoreStdDev ?? 0)).toFixed(4)} of baseline=${bc.meanScore.toFixed(4)}`
          )
        }
      }

      // Off-band invariant (in-band seed case guard)
      add(checkInBand(bc.caseId, freshMean, bc.referenceLabel, thresholds.faithfulness))

      // Accumulate for aggregate passRate
      freshN++
      if (freshMean >= thresholds.faithfulness) freshPassCount++
    } else if (allZero) {
      ok(`zeroClaimFlag — excluded from aggregate (same as baseline)`)
    }
  }

  // ── [6] Aggregate passRate exact ─────────────────────────────────────────────

  log('\n[6] Aggregate passRate exact match')
  {
    const v = checkPassRateExact(freshPassCount, freshN, baseline.aggregate.passRate, baseline.aggregate.n)
    add(v)
    if (!v) {
      const rate = freshN > 0 ? (freshPassCount / freshN).toFixed(4) : 'N/A'
      ok(`passRate=${freshPassCount}/${freshN}=${rate} matches baseline`)
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────────

  if (violations.length === 0) {
    return { status: 'green', violations: [] }
  }
  return { status: 'red', violations }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log('┌─────────────────────────────────────────────────────────────┐')
  log('│  eval gate  —  evals/run_evals.ts                           │')
  log('└─────────────────────────────────────────────────────────────┘')

  const result = await runGate()

  log('\n══════════════════════════════════════════════════════════════')
  if (result.status === 'green') {
    log('  ✓  gate-green: all checks passed')
    process.exit(EXIT_GREEN)
  } else if (result.status === 'inconclusive') {
    log(`  ~  gate-inconclusive (upstream down): ${result.inconclusiveReason ?? ''}`)
    log('     Neither green nor code-red. Re-run when Claude/Voyage recovers.')
    process.exit(EXIT_INCONCLUSIVE)
  } else {
    log(`  ✗  gate-red: ${result.violations.length} violation(s)`)
    for (const v of result.violations) {
      log(`       [${v.check}] ${v.message}`)
    }
    process.exit(EXIT_RED)
  }
}

// Only run main() when invoked directly (not when imported by tests)
const _isMain = fileURLToPath(import.meta.url) === process.argv[1]
if (_isMain) {
  main().catch((err: Error) => {
    console.error('[gate] Unexpected error:', err)
    process.exit(EXIT_RED)
  })
}
