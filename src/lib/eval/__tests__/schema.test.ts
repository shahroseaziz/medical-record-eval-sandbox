import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const GOLDEN_PATH = join(process.cwd(), 'evals/golden/seed-cases.json')
const BASELINE_PATH = join(process.cwd(), 'evals/results/seed-baseline.json')

const K = 6
const FAITHFULNESS_THRESHOLD = 0.85

interface SeedCase {
  id: string
  taskPrompt: string
  patientId: string
  ragMode: string
  expectedOutput: string
  referenceLabel: string
  requiredSections?: string[]
  expectedClaims?: string[]
  preauthoredOutput?: string
  expectedStructured?: Record<string, unknown>
  expectedProse?: string
  fieldScorers?: Record<string, string>
  rationale: string
  scorers: string[]
}

interface BaselineCase {
  caseId: string
  scorerResults: Array<{ scorer: string; score: number | null; zeroClaimFlag?: boolean }>
  meanScore: number | null
  scoreStdDev: number | null
  referenceLabel: string
}

interface BaselineFile {
  judgeModel: string
  embeddingModel: string
  k: number
  cases: BaselineCase[]
  aggregate: {
    passRate: number | null
    judgeReferenceAgreement: number | null
    n: number
    note: string
  }
}

describe('seed-cases.json schema', () => {
  let cases: SeedCase[]

  it('file exists and parses as JSON array', () => {
    expect(existsSync(GOLDEN_PATH)).toBe(true)
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    cases = JSON.parse(raw)
    expect(Array.isArray(cases)).toBe(true)
    expect(cases.length).toBeGreaterThan(0)
  })

  it('has exactly 8 cases', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    expect(c.length).toBe(8)
  })

  it('every case has required string fields', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    for (const sc of c) {
      expect(typeof sc.id, `id missing in ${sc.id}`).toBe('string')
      expect(typeof sc.taskPrompt, `taskPrompt missing in ${sc.id}`).toBe('string')
      expect(typeof sc.patientId, `patientId missing in ${sc.id}`).toBe('string')
      expect(['retrieve', 'stuff'], `invalid ragMode in ${sc.id}`).toContain(sc.ragMode)
      expect(typeof sc.expectedOutput, `expectedOutput missing in ${sc.id}`).toBe('string')
      expect(['pass', 'fail'], `invalid referenceLabel in ${sc.id}`).toContain(sc.referenceLabel)
      expect(typeof sc.rationale, `rationale missing in ${sc.id}`).toBe('string')
      expect(Array.isArray(sc.scorers), `scorers not array in ${sc.id}`).toBe(true)
      expect(sc.scorers.length, `scorers empty in ${sc.id}`).toBeGreaterThan(0)
    }
  })

  it('patientIds are from the committed fixtures', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    const FIXTURE_IDS = new Set([
      'e0de7b0a-c40b-6467-c099-0f9467be6c0a', // Agustin437
      '7a351fec-de09-1605-7053-5bfb6766dffa',   // Brenna468
      'a08c7d55-8400-6d5d-908f-13a33e8214c0',   // Marisela850
    ])
    for (const sc of c) {
      expect(FIXTURE_IDS.has(sc.patientId), `unknown patientId in ${sc.id}: ${sc.patientId}`).toBe(true)
    }
  })

  it('requiredSections.length <= k for all retrieve cases', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    for (const sc of c) {
      if (sc.ragMode === 'retrieve' && sc.requiredSections) {
        expect(
          sc.requiredSections.length,
          `requiredSections.length > k=${K} in case ${sc.id}`
        ).toBeLessThanOrEqual(K)
      }
    }
  })

  it('has at least 5 faithfulness cases and 2 contains cases', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    const faithCases = c.filter((sc) => sc.scorers.includes('faithfulness'))
    const containsCases = c.filter((sc) => sc.scorers.includes('contains'))
    expect(faithCases.length).toBeGreaterThanOrEqual(5)
    expect(containsCases.length).toBeGreaterThanOrEqual(2)
  })

  it('has at least one faithfulness PASS and one faithfulness FAIL', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    const faithCases = c.filter((sc) => sc.scorers.includes('faithfulness'))
    const passCases = faithCases.filter((sc) => sc.referenceLabel === 'pass')
    const failCases = faithCases.filter((sc) => sc.referenceLabel === 'fail')
    expect(passCases.length).toBeGreaterThanOrEqual(1)
    expect(failCases.length).toBeGreaterThanOrEqual(1)
  })

  it('has at least one retrieve case using Agustin437', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    const agustinRetrieve = c.filter(
      (sc) =>
        sc.ragMode === 'retrieve' &&
        sc.patientId === 'e0de7b0a-c40b-6467-c099-0f9467be6c0a'
    )
    expect(agustinRetrieve.length).toBeGreaterThanOrEqual(1)
  })

  it('has at least one stuff case', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    const stuffCases = c.filter((sc) => sc.ragMode === 'stuff')
    expect(stuffCases.length).toBeGreaterThanOrEqual(1)
  })

  it('all case ids are unique', () => {
    const raw = readFileSync(GOLDEN_PATH, 'utf-8')
    const c: SeedCase[] = JSON.parse(raw)
    const ids = c.map((sc) => sc.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('seed-baseline.json schema (when present)', () => {
  it('baseline file is either absent or schema-valid with off-band faithfulness scores', () => {
    if (!existsSync(BASELINE_PATH)) {
      // Baseline not yet generated — CI will generate it on first run
      return
    }

    const raw = readFileSync(BASELINE_PATH, 'utf-8')
    const baseline: BaselineFile = JSON.parse(raw)

    expect(typeof baseline.judgeModel).toBe('string')
    expect(typeof baseline.embeddingModel).toBe('string')
    expect(typeof baseline.k).toBe('number')
    expect(Array.isArray(baseline.cases)).toBe(true)
    expect(baseline.aggregate).toBeDefined()
    expect(typeof baseline.aggregate.n).toBe('number')
    expect(baseline.aggregate.note).toBe('directional, n=6-8')

    // Validate each case has required shape
    for (const bc of baseline.cases) {
      expect(typeof bc.caseId, `caseId missing`).toBe('string')
      expect(Array.isArray(bc.scorerResults), `scorerResults not array in ${bc.caseId}`).toBe(true)
      expect(['pass', 'fail'], `invalid referenceLabel in ${bc.caseId}`).toContain(bc.referenceLabel)
    }

    // Faithfulness cases must be off the 0.85 band
    const goldenRaw = readFileSync(GOLDEN_PATH, 'utf-8')
    const seedCases: SeedCase[] = JSON.parse(goldenRaw)
    const faithCaseIds = new Set(
      seedCases.filter((sc) => sc.scorers.includes('faithfulness')).map((sc) => sc.id)
    )

    for (const bc of baseline.cases) {
      if (!faithCaseIds.has(bc.caseId)) continue
      if (bc.meanScore === null) continue

      const faithResult = bc.scorerResults.find((r) => r.scorer === 'faithfulness')
      if (!faithResult || faithResult.zeroClaimFlag) continue

      const sc = seedCases.find((s) => s.id === bc.caseId)!
      if (sc.referenceLabel === 'pass') {
        expect(
          bc.meanScore,
          `Pass case ${bc.caseId} has meanScore ${bc.meanScore} which is not > ${FAITHFULNESS_THRESHOLD} (in-band — violates off-band invariant)`
        ).toBeGreaterThan(FAITHFULNESS_THRESHOLD)
      } else {
        expect(
          bc.meanScore,
          `Fail case ${bc.caseId} has meanScore ${bc.meanScore} which is not < ${FAITHFULNESS_THRESHOLD} (in-band — violates off-band invariant)`
        ).toBeLessThan(FAITHFULNESS_THRESHOLD)
      }
    }
  })
})
