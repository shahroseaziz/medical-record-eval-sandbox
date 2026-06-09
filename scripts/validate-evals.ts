/**
 * validate-evals.ts
 *
 * CI validation for eval artifacts.  Always runs.
 *
 * Checks:
 *   1. seed-cases.json is schema-valid
 *   2. requiredSections.length <= k for every retrieve case
 *   3. seed-baseline.json is schema-valid (once present)
 *   4. Every faithfulness case in the baseline is off the 0.85 band:
 *        referenceLabel=pass  →  meanScore > 0.85
 *        referenceLabel=fail  →  meanScore < 0.85
 *      Zero-claim cases are exempted from the band check.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const GOLDEN_PATH = join(process.cwd(), 'evals/golden/seed-cases.json')
const BASELINE_PATH = join(process.cwd(), 'evals/results/seed-baseline.json')

const K = 6
const FAITHFULNESS_THRESHOLD = 0.85

const FIXTURE_PATIENT_IDS = new Set([
  'e0de7b0a-c40b-6467-c099-0f9467be6c0a', // Agustin437
  '7a351fec-de09-1605-7053-5bfb6766dffa', // Brenna468
  'a08c7d55-8400-6d5d-908f-13a33e8214c0', // Marisela850
])

const VALID_RAG_MODES = new Set(['retrieve', 'stuff'])
const VALID_LABELS = new Set(['pass', 'fail'])
const VALID_SCORERS = new Set([
  'faithfulness',
  'contains',
  'section-hit',
  'extraction-completeness',
  'structured-diff',
  'reference-judge',
])

let errors = 0

function fail(msg: string): void {
  console.error(`  FAIL  ${msg}`)
  errors++
}

function ok(msg: string): void {
  console.log(`  OK    ${msg}`)
}

// ── seed-cases.json ──────────────────────────────────────────────────────────

console.log('\n[1] Validating evals/golden/seed-cases.json ...')

if (!existsSync(GOLDEN_PATH)) {
  fail(`File not found: ${GOLDEN_PATH}`)
  process.exit(1)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let seedCases: any[]
try {
  seedCases = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  if (!Array.isArray(seedCases)) throw new Error('Root must be an array')
  ok(`Parsed ${seedCases.length} cases`)
} catch (e) {
  fail(`JSON parse error: ${(e as Error).message}`)
  process.exit(1)
}

const seenIds = new Set<string>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const sc of seedCases as any[]) {
  const id: string = sc.id ?? '<missing-id>'

  // Required string fields
  for (const field of [
    'id',
    'taskPrompt',
    'patientId',
    'ragMode',
    'referenceLabel',
    'rationale',
  ] as const) {
    if (typeof sc[field] !== 'string' || sc[field] === '') {
      fail(`Case ${id}: field "${field}" must be a non-empty string`)
    }
  }

  // expectedOutput must be a string (may be empty for faithfulness cases)
  if (typeof sc.expectedOutput !== 'string') {
    fail(`Case ${id}: expectedOutput must be a string`)
  }

  // Enum checks
  if (!VALID_RAG_MODES.has(sc.ragMode)) {
    fail(`Case ${id}: ragMode must be "retrieve" or "stuff", got "${sc.ragMode}"`)
  }
  if (!VALID_LABELS.has(sc.referenceLabel)) {
    fail(`Case ${id}: referenceLabel must be "pass" or "fail", got "${sc.referenceLabel}"`)
  }

  // patientId must be a committed fixture
  if (!FIXTURE_PATIENT_IDS.has(sc.patientId)) {
    fail(`Case ${id}: patientId "${sc.patientId}" is not one of the 3 committed fixtures`)
  }

  // scorers
  if (!Array.isArray(sc.scorers) || sc.scorers.length === 0) {
    fail(`Case ${id}: scorers must be a non-empty array`)
  } else {
    for (const s of sc.scorers) {
      if (!VALID_SCORERS.has(s)) {
        fail(`Case ${id}: unknown scorer "${s}"`)
      }
    }
  }

  // replayReferenceJudge (record-replay fixture) shape, when present
  if (sc.replayReferenceJudge !== undefined) {
    const rj = sc.replayReferenceJudge
    if (typeof rj !== 'object' || rj === null) {
      fail(`Case ${id}: replayReferenceJudge must be an object`)
    } else {
      if (!new Set(['equivalent', 'partial', 'divergent']).has(rj.verdict)) {
        fail(`Case ${id}: replayReferenceJudge.verdict must be equivalent|partial|divergent`)
      }
      if (typeof rj.reason !== 'string' || rj.reason === '') {
        fail(`Case ${id}: replayReferenceJudge.reason must be a non-empty string`)
      }
    }
    if (!Array.isArray(sc.scorers) || !sc.scorers.includes('reference-judge')) {
      fail(`Case ${id}: replayReferenceJudge requires the reference-judge scorer`)
    }
    if (typeof sc.expectedProse !== 'string' || sc.expectedProse === '') {
      fail(`Case ${id}: replayReferenceJudge requires a non-empty expectedProse`)
    }
  }

  // requiredSections.length <= k for retrieve cases
  if (sc.ragMode === 'retrieve' && Array.isArray(sc.requiredSections)) {
    if (sc.requiredSections.length > K) {
      fail(`Case ${id}: requiredSections.length=${sc.requiredSections.length} > k=${K}`)
    }
  }

  // Unique ids
  if (seenIds.has(id)) {
    fail(`Duplicate case id: "${id}"`)
  } else {
    seenIds.add(id)
  }
}

if (errors === 0) ok('seed-cases.json is schema-valid')

// Count case types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const faithCases = (seedCases as any[]).filter(
  (sc) => Array.isArray(sc.scorers) && sc.scorers.includes('faithfulness'),
)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const containsCases = (seedCases as any[]).filter(
  (sc) => Array.isArray(sc.scorers) && sc.scorers.includes('contains'),
)
const faithPass = faithCases.filter((sc) => sc.referenceLabel === 'pass')
const faithFail = faithCases.filter((sc) => sc.referenceLabel === 'fail')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const retrieveCases = (seedCases as any[]).filter((sc) => sc.ragMode === 'retrieve')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stuffCases = (seedCases as any[]).filter((sc) => sc.ragMode === 'stuff')

console.log(
  `\n  Case counts: total=${seedCases.length} faithfulness=${faithCases.length} contains=${containsCases.length}`,
)
console.log(`  Faithfulness: pass=${faithPass.length} fail=${faithFail.length}`)
console.log(`  Modes: retrieve=${retrieveCases.length} stuff=${stuffCases.length}`)

if (faithCases.length < 5) fail(`Need >= 5 faithfulness cases, found ${faithCases.length}`)
if (containsCases.length < 2) fail(`Need >= 2 contains cases, found ${containsCases.length}`)
if (faithPass.length < 1) fail('Need >= 1 faithfulness PASS case')
if (faithFail.length < 1) fail('Need >= 1 faithfulness FAIL case')
if (retrieveCases.length < 1) fail('Need >= 1 retrieve case')
if (stuffCases.length < 1) fail('Need >= 1 stuff case')

const agustinRetrieve = retrieveCases.filter(
  (sc) => sc.patientId === 'e0de7b0a-c40b-6467-c099-0f9467be6c0a',
)
if (agustinRetrieve.length < 1) fail('Need >= 1 retrieve case for Agustin437 (e0de7b0a-...)')
else ok('Agustin437 retrieve case present')

// ── seed-baseline.json (once present) ────────────────────────────────────────

console.log('\n[2] Validating evals/results/seed-baseline.json ...')

if (!existsSync(BASELINE_PATH)) {
  ok('Baseline not yet generated — skipping baseline checks (will run after first CI generation)')
  console.log('\nValidation complete.')
  process.exit(errors > 0 ? 1 : 0)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let baseline: any
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
  ok('Parsed baseline JSON')
} catch (e) {
  fail(`Baseline JSON parse error: ${(e as Error).message}`)
  process.exit(1)
}

// Top-level required fields
for (const field of ['judgeModel', 'embeddingModel', 'k', 'generatedAt', 'cases', 'aggregate']) {
  if (baseline[field] === undefined) fail(`Baseline missing field "${field}"`)
}
if (typeof baseline.k !== 'number') fail('Baseline k must be a number')
if (!Array.isArray(baseline.cases)) fail('Baseline cases must be an array')

const agg = baseline.aggregate
if (!agg) {
  fail('Baseline missing aggregate')
} else {
  for (const field of ['n', 'note']) {
    if (agg[field] === undefined) fail(`Baseline aggregate missing field "${field}"`)
  }
  if (agg.note !== 'directional, n=6-8')
    fail(`Baseline aggregate.note must be "directional, n=6-8", got "${agg.note}"`)
}

// Per-case validation + off-band check
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const faithCaseIdSet = new Set<string>(faithCases.map((sc: any) => sc.id))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const seedCaseMap = new Map<string, any>(seedCases.map((sc: any) => [sc.id, sc]))

let offBandErrors = 0

// eslint-disable-next-line @typescript-eslint/no-explicit-any
for (const bc of baseline.cases as any[]) {
  if (typeof bc.caseId !== 'string') {
    fail('Baseline case missing caseId')
    continue
  }
  if (!Array.isArray(bc.scorerResults))
    fail(`Baseline case ${bc.caseId}: scorerResults must be an array`)
  if (!VALID_LABELS.has(bc.referenceLabel))
    fail(`Baseline case ${bc.caseId}: invalid referenceLabel "${bc.referenceLabel}"`)

  // Off-band check: faithfulness cases only, non-zero-claim
  if (!faithCaseIdSet.has(bc.caseId)) continue
  if (bc.meanScore === null || bc.meanScore === undefined) continue

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const faithResult = (bc.scorerResults as any[]).find((r) => r.scorer === 'faithfulness')
  if (faithResult?.zeroClaimFlag) continue // exempt

  const seed = seedCaseMap.get(bc.caseId)
  if (!seed) continue

  const score: number = bc.meanScore
  if (seed.referenceLabel === 'pass' && score <= FAITHFULNESS_THRESHOLD) {
    fail(
      `Case ${bc.caseId} (referenceLabel=pass) has meanScore=${score.toFixed(3)} which is <= threshold ${FAITHFULNESS_THRESHOLD} — in-band, violates off-band invariant`,
    )
    offBandErrors++
  } else if (seed.referenceLabel === 'fail' && score >= FAITHFULNESS_THRESHOLD) {
    fail(
      `Case ${bc.caseId} (referenceLabel=fail) has meanScore=${score.toFixed(3)} which is >= threshold ${FAITHFULNESS_THRESHOLD} — in-band, violates off-band invariant`,
    )
    offBandErrors++
  } else {
    ok(`Case ${bc.caseId} (${seed.referenceLabel}): meanScore=${score.toFixed(3)} — off-band ✓`)
  }
}

if (offBandErrors === 0 && baseline.cases?.length > 0)
  ok('All faithfulness cases are off the 0.85 band')

// ── Kappa gate ───────────────────────────────────────────────────────────────

console.log('\n[3] Checking judge-vs-human kappa against threshold ...')

// Parse thresholds.yaml without a YAML library (simple key: value format)
const THRESHOLDS_PATH = join(process.cwd(), 'evals/thresholds.yaml')
let judgeKappaMin = 0
if (existsSync(THRESHOLDS_PATH)) {
  const thresholdsRaw = readFileSync(THRESHOLDS_PATH, 'utf-8')
  const match = thresholdsRaw.match(/^judge_kappa_min\s*:\s*([0-9.]+)/m)
  if (match) {
    judgeKappaMin = parseFloat(match[1])
    ok(`Loaded judge_kappa_min=${judgeKappaMin} from thresholds.yaml`)
  } else {
    fail('judge_kappa_min not found in thresholds.yaml')
  }
} else {
  fail(`thresholds.yaml not found: ${THRESHOLDS_PATH}`)
}

if (judgeKappaMin > 0) {
  const agg = baseline?.aggregate
  if (agg && typeof agg.judgeHumanKappa === 'number') {
    if (agg.judgeHumanKappa < judgeKappaMin) {
      fail(
        `Judge-vs-human kappa=${agg.judgeHumanKappa.toFixed(4)} is below judge_kappa_min=${judgeKappaMin} — run scripts/compute-kappa.ts after regenerating baseline`,
      )
    } else {
      ok(
        `Judge-vs-human kappa=${agg.judgeHumanKappa.toFixed(4)} >= judge_kappa_min=${judgeKappaMin}`,
      )
    }
  } else if (agg && agg.judgeHumanKappa === null) {
    fail(
      'Baseline aggregate.judgeHumanKappa is null — kappa could not be computed; check human-labels.json',
    )
  } else {
    fail(
      'judgeHumanKappa absent from baseline aggregate — run npm run compute:kappa before committing baseline',
    )
  }
}

console.log('\nValidation complete.')
if (errors > 0) {
  console.error(`\n${errors} validation error(s) — failing build`)
  process.exit(1)
}
console.log('All checks passed.')
