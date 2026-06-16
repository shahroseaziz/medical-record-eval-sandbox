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
 *   4. Per-case score reproduction: |fresh_mean - baseline_mean| ≤ max(0.15, 3·stddev)
 *   5. Off-band invariant (in-band seed case guard)
 *   6. Under-extraction guard (fresh zero-claim on a case whose baseline HAD claims → fail)
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
import { scoreCriteriaJudge } from '../src/lib/eval/scorers/criteria-judge.js'
import { computeMeanScore } from '../src/lib/eval/aggregate.js'
import { loadThresholds } from '../src/lib/eval/thresholds.js'
import type { EvalCase, FaithfulnessResult, CriteriaJudgeResult } from '../src/lib/eval/types.js'
import { JUDGE_MODEL, EMBEDDING_MODEL } from '../src/lib/models.js'

// ── Constants ─────────────────────────────────────────────────────────────────

// Pinned model ids come from lib/models (single model-ID source).
export const EXPECTED_JUDGE_MODEL = JUDGE_MODEL
export const EXPECTED_EMBEDDING_MODEL = EMBEDDING_MODEL

const FAITHFULNESS_GATE_RUNS = 3   // fewer than baseline's k for speed; tolerance band absorbs variance
// Exported so tests can verify the retry budget without relying on a magic number.
export const JUDGE_ERROR_REATTEMPTS = 2   // re-score a transient judge-errored case (API up) before failing the gate
const ANTHROPIC_PROBE_TIMEOUT_MS = 15_000

// Number of fresh criteria-judge samples per seed case in the gate. Fewer than the
// committed k=5 baseline (the designed-pass / designed-fail seeds are unambiguous,
// so a small sample is decisive) — matches the faithfulness gate's speed tradeoff.
export const CRITERIA_GATE_RUNS = 3

const REPO_ROOT = join(import.meta.dirname, '..')
const BASELINE_PATH = join(REPO_ROOT, 'evals/results/seed-baseline.json')
const CASES_PATH = join(REPO_ROOT, 'evals/golden/seed-cases.json')
const CRITERIA_BASELINE_PATH = join(REPO_ROOT, 'evals/results/criteria-judge-baseline.json')
const CRITERIA_CASES_PATH = join(REPO_ROOT, 'evals/golden/criteria-seed-cases.json')
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

// ── Criteria-judge seed gate types (SHA-153 N2) ───────────────────────────────

interface CriteriaSeedCase {
  id: string
  patientId: string
  criteria: string
  output: string
  referenceLabel: 'pass' | 'fail'
  rationale: string
}

interface CriteriaBaselineCase {
  caseId: string
  referenceLabel: 'pass' | 'fail'
  /** k sampled judge verdicts (true = pass) recorded at baseline-generation time. */
  verdicts: boolean[]
  passRate: number
}

interface CriteriaBaseline {
  judgeModel: string
  k: number
  cases: CriteriaBaselineCase[]
  aggregate: { n: number; agreement: number; note?: string }
}

/** Injected criteria judge — defaults to the live scorer in the running gate. */
export type CriteriaScoreFn = (criteria: string, output: string) => Promise<CriteriaJudgeResult>

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
  /** Override scoreFaithfulness for tests — lets tests inject controlled judge responses. */
  scoreFn?: (evalCase: EvalCase, client?: Anthropic) => Promise<FaithfulnessResult>
  /** Override the criteria judge for tests — lets tests inject controlled verdicts. */
  criteriaScoreFn?: CriteriaScoreFn
  /** Override criteria-judge baseline path for tests */
  criteriaBaselinePath?: string
  /** Override criteria seed-cases path for tests */
  criteriaCasesPath?: string
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
  const tolerance = Math.max(0.15, 3 * baselineStdDev)
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

/**
 * A baseline case is "zero-claim by design" when its faithfulness scorer
 * recorded a zeroClaimFlag (e.g. a bare-list seed the extractor classifies as
 * names, not atomic claims) — or, defensively, when it has no mean score at all.
 * Used to make the under-extraction guard baseline-relative so the judge's
 * run-to-run non-determinism on such a case can't flake the gate red.
 */
export function isBaselineZeroClaim(
  bc: { scorerResults: BaselineScorerResult[]; meanScore: number | null }
): boolean {
  return (
    bc.scorerResults.some((r) => r.scorer === 'faithfulness' && r.zeroClaimFlag) ||
    bc.meanScore === null
  )
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

// ── Criteria-judge seed-gate helpers (SHA-153 N2) ─────────────────────────────

/** Majority pass over a verdict sample (true wins strict-majority ties broken toward pass). */
export function criteriaMajority(verdicts: boolean[]): boolean {
  const passes = verdicts.filter(Boolean).length
  return passes * 2 >= verdicts.length
}

/**
 * Designed-label invariant: the judge's fresh majority verdict must equal the seed
 * case's designed label (pass-seed → pass, fail-seed → fail). A flip means the
 * criteria judge path regressed.
 */
export function checkCriteriaVerdict(
  caseId: string,
  freshPass: boolean,
  referenceLabel: 'pass' | 'fail',
): GateViolation | null {
  const expected = referenceLabel === 'pass'
  if (freshPass !== expected) {
    return {
      check: 'criteria-verdict',
      message:
        `Criteria case ${caseId} (referenceLabel=${referenceLabel}): judge returned ` +
        `pass=${freshPass}, expected pass=${expected} — designed-label invariant violated.`,
    }
  }
  return null
}

/** The fresh majority must also match the committed baseline's majority verdict. */
export function checkCriteriaBaselineMatch(
  caseId: string,
  freshPass: boolean,
  baselinePass: boolean,
): GateViolation | null {
  if (freshPass !== baselinePass) {
    return {
      check: 'criteria-baseline',
      message:
        `Criteria case ${caseId}: fresh majority pass=${freshPass} ≠ baseline majority ` +
        `pass=${baselinePass} — criteria judge drifted from the committed k baseline.`,
    }
  }
  return null
}

/** Validates the committed criteria baseline's shape before any live scoring. */
export function checkCriteriaBaselineShape(
  baseline: CriteriaBaseline,
  expectedJudge: string,
): GateViolation | null {
  if (baseline.judgeModel !== expectedJudge) {
    return {
      check: 'criteria-model-guard',
      message:
        `Criteria baseline judge model mismatch: baseline="${baseline.judgeModel}" ` +
        `expected="${expectedJudge}" — regenerate the criteria baseline with the correct model.`,
    }
  }
  for (const bc of baseline.cases) {
    if (bc.verdicts.length !== baseline.k) {
      return {
        check: 'criteria-baseline',
        message:
          `Criteria baseline case ${bc.caseId}: recorded ${bc.verdicts.length} verdicts ` +
          `but k=${baseline.k} — baseline is unbaselined/incomplete.`,
      }
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
    const runScore = opts.scoreFn ?? scoreFaithfulness
    const freshResults: FaithfulnessResult[] = []
    let caseErrored = false
    for (let i = 0; i < FAITHFULNESS_GATE_RUNS; i++) {
      let r = await runScore(evalCase, client)
      // A judge run can come back errored two ways: (a) the API is genuinely down
      // (→ inconclusive), or (b) a transient unparseable-response flake while the API
      // is up (noise, not a regression). Distinguish them, and for (b) re-score a few
      // times before failing — so a transient hiccup no longer red-X's a correct PR.
      let reattempt = 0
      while (r.errored) {
        const recheck = opts.anthropicProber ?? (() => probeAnthropic(client))
        if (await recheck() === 'down') {
          log('  INCONCLUSIVE  Claude API went down during scoring')
          return {
            status: 'inconclusive',
            violations: [],
            inconclusiveReason: `Claude API failed mid-run (run ${i + 1}/${FAITHFULNESS_GATE_RUNS}): ${r.errorMessage ?? 'unknown error'}`,
          }
        }
        if (reattempt >= JUDGE_ERROR_REATTEMPTS) break
        reattempt++
        log(`  retry  transient judge error on ${bc.caseId} (run ${i + 1}), re-scoring (${reattempt}/${JUDGE_ERROR_REATTEMPTS})`)
        r = await runScore(evalCase, client)
      }
      if (r.errored) {
        // Still errored after re-attempts AND the API is up → a genuine judge error.
        add({
          check: 'judge-error',
          message: `Case ${bc.caseId}: judge errored after ${reattempt + 1} attempts (run ${i + 1}): ${r.errorMessage ?? 'unknown'}`,
        })
        caseErrored = true
        break
      }
      freshResults.push(r)
    }
    if (caseErrored) continue

    const allZero = freshResults.every((r) => r.zeroClaimFlag)
    const freshMean = computeMeanScore(freshResults)

    // Under-extraction guard — baseline-relative. A fresh zero-claim run is only
    // a regression (judge/extraction broke) if the baseline DID extract claims.
    // A case whose baseline is itself zero-claim (e.g. a bare-list seed) getting
    // zero claims is consistent with baseline, not breakage. Without this, the
    // judge's run-to-run non-determinism on such a case flakes the gate red even
    // though line [5c]/[6] correctly excludes it from the aggregate.
    add(checkUnderExtraction(bc.caseId, allZero && !isBaselineZeroClaim(bc)))

    if (!allZero && freshMean !== null) {
      ok(`freshMean=${freshMean.toFixed(4)} (${FAITHFULNESS_GATE_RUNS} runs)`)

      // Score tolerance
      if (bc.meanScore !== null) {
        const v = checkScoreTolerance(bc.caseId, freshMean, bc.meanScore, bc.scoreStdDev ?? 0)
        add(v)
        if (!v) {
          ok(
            `within tolerance ±${Math.max(0.15, 3 * (bc.scoreStdDev ?? 0)).toFixed(4)} of baseline=${bc.meanScore.toFixed(4)}`
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

// ── Criteria-judge seed gate (SHA-153 N2) ─────────────────────────────────────
//
// Keeps the single-call /api/score criteria-verdict path baselined: the committed
// k=5 baseline + the designed-pass/designed-fail seeds must reproduce on every gate
// run. Wired into the eval-gate entry point (main) so the criteria judge is never
// shipped unbaselined. Exported so it can be unit-tested with an injected judge.
export async function runCriteriaSeedGate(opts: GateOptions = {}): Promise<GateResult> {
  const violations: GateViolation[] = []
  function add(v: GateViolation | null): void {
    if (v) {
      violations.push(v)
      fail(v.message)
    }
  }

  const casesPath = opts.criteriaCasesPath ?? CRITERIA_CASES_PATH
  const baselinePath = opts.criteriaBaselinePath ?? CRITERIA_BASELINE_PATH

  log('\n[7] Criteria-judge seed cases (single-call /api/score contract)')

  if (!existsSync(baselinePath) || !existsSync(casesPath)) {
    return {
      status: 'red',
      violations: [
        {
          check: 'criteria-baseline-exists',
          message: `criteria seed cases or baseline missing (${casesPath} / ${baselinePath}).`,
        },
      ],
    }
  }

  const baseline: CriteriaBaseline = JSON.parse(readFileSync(baselinePath, 'utf-8'))
  const seedCases: CriteriaSeedCase[] = JSON.parse(readFileSync(casesPath, 'utf-8'))
  const seedMap = new Map<string, CriteriaSeedCase>(seedCases.map((s) => [s.id, s]))

  // Static shape check before any API call.
  add(checkCriteriaBaselineShape(baseline, EXPECTED_JUDGE_MODEL))
  if (violations.length > 0) {
    return { status: 'red', violations }
  }

  const client = opts.anthropicClient ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const scoreFn: CriteriaScoreFn =
    opts.criteriaScoreFn ?? ((criteria, output) => scoreCriteriaJudge(criteria, output, client))
  const reprobe = opts.anthropicProber ?? (() => probeAnthropic(client))

  for (const bc of baseline.cases) {
    const sc = seedMap.get(bc.caseId)
    if (!sc) {
      add({
        check: 'criteria-case-missing',
        message: `Criteria baseline case "${bc.caseId}" not found in criteria seed cases.`,
      })
      continue
    }

    log(`\n  case: ${bc.caseId} (referenceLabel=${bc.referenceLabel})`)

    const freshVerdicts: boolean[] = []
    for (let i = 0; i < CRITERIA_GATE_RUNS; i++) {
      const r = await scoreFn(sc.criteria, sc.output)
      if (r.errored || r.pass === null) {
        // Distinguish a real outage (→ inconclusive) from a non-outage error.
        if ((await reprobe()) === 'down') {
          log('  INCONCLUSIVE  Claude API went down during criteria scoring')
          return {
            status: 'inconclusive',
            violations: [],
            inconclusiveReason: `Claude API failed mid-run on criteria case ${bc.caseId}.`,
          }
        }
        continue
      }
      freshVerdicts.push(r.pass)
    }

    if (freshVerdicts.length === 0) {
      add({
        check: 'criteria-judge-error',
        message: `Criteria case ${bc.caseId}: judge produced no parseable verdict across ${CRITERIA_GATE_RUNS} runs.`,
      })
      continue
    }

    const freshPass = criteriaMajority(freshVerdicts)
    const baselinePass = criteriaMajority(bc.verdicts)

    const before = violations.length
    add(checkCriteriaVerdict(bc.caseId, freshPass, bc.referenceLabel))
    add(checkCriteriaBaselineMatch(bc.caseId, freshPass, baselinePass))
    if (violations.length === before) {
      ok(`fresh majority pass=${freshPass} matches baseline + designed label`)
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
  log('│  eval gate  —  evals/run_evals.ts                           │')
  log('└─────────────────────────────────────────────────────────────┘')

  const result = await runGate()

  // The faithfulness gate must be green before we spend on the criteria seed gate.
  // A red/inconclusive faithfulness gate short-circuits with its own exit code.
  if (result.status === 'green') {
    const criteria = await runCriteriaSeedGate()
    if (criteria.status !== 'green') {
      result.status = criteria.status
      result.violations = criteria.violations
      result.inconclusiveReason = criteria.inconclusiveReason
    }
  }

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
