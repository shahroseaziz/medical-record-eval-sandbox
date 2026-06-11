// @vitest-environment jsdom
//
// O2 / S21 — BenchSet store, legacy → v4 migration, JSON export/import, quota.
// Named to match the `pnpm test -- benchset migration` verify filter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  // types
  type BenchSet,
  type BenchCaseV4,
  type UserCase,
  type UserCaseV3,
  // store
  loadBenchStore,
  loadBenchSets,
  saveBenchSet,
  getBenchSet,
  deleteBenchSet,
  // migration
  migrateLegacyToV4,
  scanLegacyCases,
  buildMigratedCases,
  buildMigratedLabels,
  // export/import + validation
  exportBenchSet,
  importBenchSet,
  validateBenchSet,
  BenchSetValidationError,
  // quota
  preflightQuota,
  saveBenchStore as persistStore,
  BenchQuotaExceededError,
  LOCALSTORAGE_BUDGET_BYTES,
  // completion
  setCompletion,
} from '../cases'

const BENCH_KEY = 'bench_sets_v4'
const MIGRATION_FLAG = 'migration_v4_done'

// ── fixtures ─────────────────────────────────────────────────────────────────

// Legacy store #1 — the "My Cases" key (user_cases_v1).
const V1_FIXTURE: UserCase[] = [
  {
    id: 'v1-aaa',
    patientId: 'Agustin437_Hills818',
    query: 'List the active medications.',
    mode: 'retrieve',
    expectedOutput: 'Metformin 500mg; Lisinopril 10mg',
    k: 6,
    createdAt: 1_700_000_000_000,
  },
  {
    id: 'v1-bbb',
    patientId: 'Marisela850',
    query: 'Summarize the last visit.',
    mode: 'stuff',
    record: '<ccda/>',
    createdAt: 1_700_000_100_000,
  },
]

// Legacy store #2 — the golden-set builder (user_cases_v3).
const V3_FIXTURE: UserCaseV3[] = [
  {
    version: 3,
    id: 'v3-ccc',
    taskPrompt: 'Extract the problem list.',
    patientId: 'Brenna468',
    ragMode: 'retrieve',
    capturedOutput: 'Type 2 diabetes; Hypertension',
    capturedGrounding: { mode: 'retrieve', chunks: [] },
    expectedProse: 'The patient has type 2 diabetes and hypertension.',
    fieldScorers: { prose: 'faithfulness' },
    intentLabel: 'pass',
    provenance: { genPromptHash: 'abc123', patientId: 'Brenna468', ragMode: 'retrieve', k: 6 },
    createdAt: 1_700_000_200_000,
  },
  {
    version: 3,
    id: 'v3-ddd',
    taskPrompt: 'Medications as JSON.',
    patientId: 'Hills818',
    ragMode: 'stuff',
    capturedOutput: '{}',
    capturedGrounding: { mode: 'stuff', record: '<ccda/>' },
    // a v3 scorer outside the v4 union → must be dropped on migration
    fieldScorers: { structured: 'contains' } as UserCaseV3['fieldScorers'],
    intentLabel: 'fail',
    designedFailReason: 'under-extraction',
    provenance: { genPromptHash: 'def456', patientId: 'Hills818', ragMode: 'stuff' },
    createdAt: 1_700_000_300_000,
  },
]

function seedLegacy() {
  localStorage.setItem('user_cases_v1', JSON.stringify(V1_FIXTURE))
  localStorage.setItem('user_cases_v3', JSON.stringify(V3_FIXTURE))
}

function makeSet(overrides: Partial<BenchSet> = {}): BenchSet {
  const cases: BenchCaseV4[] = [
    {
      version: 4,
      id: 'case-1',
      taskPrompt: 'List meds.',
      patientId: 'p1',
      ragMode: 'retrieve',
      expectedProse: 'Metformin and lisinopril.',
      expectedStructured: [{ drug: 'Metformin', dose: '500mg', route: 'oral', status: 'active' }],
      fieldScorers: { prose: 'reference-judge', structured: 'structured-diff' },
      createdAt: 100,
    },
  ]
  return {
    id: 'set-1',
    name: 'My Set',
    createdAt: 50,
    cases,
    labels: { 'case-1': 'pass' },
    runs: {
      current: {
        genPromptHash: 'g1',
        rubricHash: 'r1',
        threshold: 0.85,
        scorerAssignments: { 'case-1': { prose: 'reference-judge' } },
        outputs: {
          'case-1': {
            text: 'Metformin 500mg, lisinopril 10mg.',
            genPromptHash: 'g1',
            capturedGrounding: {
              mode: 'retrieve',
              chunks: [{ text: 'meds', section: 'medications', distance: 0.1, similarity: 0.9 }],
            },
          },
        },
        scores: {
          'case-1': { caseId: 'case-1', fields: [], score: 0.9, state: 'matched', excluded: false },
        },
        timestamp: 200,
      },
      previous: null,
    },
    ...overrides,
  }
}

beforeEach(() => {
  localStorage.clear()
})

// ── round-trip ───────────────────────────────────────────────────────────────

describe('JSON export/import round-trip (S21 accept)', () => {
  it('export → import yields a deeply identical set', () => {
    const set = makeSet()
    const restored = importBenchSet(exportBenchSet(set))
    expect(restored).toEqual(set)
  })

  it('export is a fixpoint: export → import → export is byte-identical', () => {
    const set = makeSet()
    const json1 = exportBenchSet(set)
    const json2 = exportBenchSet(importBenchSet(json1))
    expect(json2).toBe(json1)
  })

  it('round-trips a set through the store CRUD path', () => {
    const set = makeSet()
    saveBenchSet(set)
    expect(getBenchSet('set-1')).toEqual(set)
    expect(loadBenchSets()).toHaveLength(1)
  })
})

// ── migration: both legacy stores ────────────────────────────────────────────

describe('legacy → v4 migration (both stores, D5)', () => {
  it('imports cases from BOTH user_cases_v1 and user_cases_v3 into a "Migrated" set', () => {
    seedLegacy()
    const result = migrateLegacyToV4()
    expect(result.ran).toBe(true)
    expect(result.imported).toBe(4)
    const set = getBenchSet('migrated-v4')!
    expect(set.name).toBe('Migrated')
    const ids = set.cases.map((c) => c.id).sort()
    expect(ids).toEqual(['v1-aaa', 'v1-bbb', 'v3-ccc', 'v3-ddd'])
    expect(set.cases.every((c) => c.version === 4)).toBe(true)
  })

  it('maps a v1 "My Cases" row: query → taskPrompt, expectedOutput → prose (reference-judge)', () => {
    seedLegacy()
    migrateLegacyToV4()
    const set = getBenchSet('migrated-v4')!
    const c = set.cases.find((x) => x.id === 'v1-aaa')!
    expect(c.taskPrompt).toBe('List the active medications.')
    expect(c.ragMode).toBe('retrieve')
    expect(c.expectedProse).toBe('Metformin 500mg; Lisinopril 10mg')
    expect(c.fieldScorers).toEqual({ prose: 'reference-judge' })
  })

  it('drops a v3 scorer outside the v4 union; keeps prose graded by reference-judge', () => {
    seedLegacy()
    migrateLegacyToV4()
    const set = getBenchSet('migrated-v4')!
    const ddd = set.cases.find((x) => x.id === 'v3-ddd')!
    expect(ddd.fieldScorers).toEqual({}) // contains was dropped; no prose to fall back on
    const ccc = set.cases.find((x) => x.id === 'v3-ccc')!
    expect(ccc.fieldScorers).toEqual({ prose: 'faithfulness' }) // v4-valid scorer preserved
  })

  it('relocates the v3 intentLabel into BenchSet.labels (E26 — not dropped)', () => {
    seedLegacy()
    migrateLegacyToV4()
    const set = getBenchSet('migrated-v4')!
    // v3-ccc was 'pass', v3-ddd was 'fail'; v1 rows carry no intent label.
    expect(set.labels).toEqual({ 'v3-ccc': 'pass', 'v3-ddd': 'fail' })
  })

  it('buildMigratedLabels carries pass/fail and skips unlabeled rows', () => {
    expect(buildMigratedLabels(V3_FIXTURE)).toEqual({ 'v3-ccc': 'pass', 'v3-ddd': 'fail' })
    const unlabeled: UserCaseV3[] = [
      { ...V3_FIXTURE[0], id: 'no-label', intentLabel: undefined as unknown as 'pass' },
    ]
    expect(buildMigratedLabels(unlabeled)).toEqual({})
  })

  it('label carry-over is idempotent across a forced re-run (byte-identical store)', () => {
    seedLegacy()
    migrateLegacyToV4()
    const afterFirst = localStorage.getItem(BENCH_KEY)
    localStorage.removeItem(MIGRATION_FLAG)
    migrateLegacyToV4()
    expect(localStorage.getItem(BENCH_KEY)).toBe(afterFirst)
  })

  it('buildMigratedCases dedups by id, v3 winning over v1 on collision', () => {
    const v1: UserCase[] = [{ id: 'dup', patientId: 'p', query: 'q1', mode: 'stuff', createdAt: 1 }]
    const v3: UserCaseV3[] = [{ ...V3_FIXTURE[0], id: 'dup' }]
    const cases = buildMigratedCases(v1, v3)
    expect(cases).toHaveLength(1)
    expect(cases[0].taskPrompt).toBe('Extract the problem list.') // v3 won
  })
})

// ── migration idempotence: named double-run test ─────────────────────────────

describe('migration idempotence (double-run → byte-identical store)', () => {
  it('importing twice leaves a byte-identical store', () => {
    seedLegacy()
    migrateLegacyToV4()
    const afterFirst = localStorage.getItem(BENCH_KEY)
    const second = migrateLegacyToV4()
    const afterSecond = localStorage.getItem(BENCH_KEY)
    expect(second.ran).toBe(false) // flag short-circuits
    expect(afterSecond).toBe(afterFirst) // byte-identical
  })

  it('is idempotent even if the done-flag is cleared (case-id dedup)', () => {
    seedLegacy()
    migrateLegacyToV4()
    const afterFirst = localStorage.getItem(BENCH_KEY)
    localStorage.removeItem(MIGRATION_FLAG) // force the guard off
    const second = migrateLegacyToV4()
    expect(second.ran).toBe(true)
    expect(second.imported).toBe(0) // dedup added nothing
    expect(localStorage.getItem(BENCH_KEY)).toBe(afterFirst) // still byte-identical
  })

  it('sets the migration_v4_done flag and reports scan state', () => {
    seedLegacy()
    expect(scanLegacyCases()).toMatchObject({ v1Count: 2, v3Count: 2, total: 4, done: false })
    migrateLegacyToV4()
    expect(localStorage.getItem(MIGRATION_FLAG)).toBe('1')
    expect(scanLegacyCases().done).toBe(true)
  })
})

// ── non-destructive: legacy keys survive ─────────────────────────────────────

describe('migration is non-destructive (no legacy key deleted)', () => {
  it('leaves user_cases_v1 and user_cases_v3 byte-for-byte intact', () => {
    seedLegacy()
    const v1Before = localStorage.getItem('user_cases_v1')
    const v3Before = localStorage.getItem('user_cases_v3')
    migrateLegacyToV4()
    expect(localStorage.getItem('user_cases_v1')).toBe(v1Before)
    expect(localStorage.getItem('user_cases_v3')).toBe(v3Before)
  })

  it('a no-legacy environment still migrates cleanly (empty Migrated set, no crash)', () => {
    const result = migrateLegacyToV4()
    expect(result.ran).toBe(true)
    expect(result.imported).toBe(0)
  })
})

// ── schema validation: named errors ──────────────────────────────────────────

describe('schema validation (named errors, never silent partial state)', () => {
  it('rejects non-JSON with a named error', () => {
    expect(() => importBenchSet('{not json')).toThrow(BenchSetValidationError)
    expect(() => importBenchSet('{not json')).toThrow(/not valid JSON/)
  })

  it('names the offending field', () => {
    const bad = { ...makeSet(), cases: 'nope' as unknown as BenchCaseV4[] }
    try {
      validateBenchSet(bad)
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(BenchSetValidationError)
      expect((err as BenchSetValidationError).field).toBe('<root>.cases')
      expect((err as Error).message).toMatch(/expected array, got string/)
    }
  })

  it('rejects an unknown scorer with the field path', () => {
    const set = makeSet()
    ;(set.cases[0].fieldScorers as Record<string, string>).prose = 'bogus'
    expect(() => validateBenchSet(set)).toThrow(/unknown scorer "bogus".*fieldScorers\.prose/)
  })

  it('rejects a bad ragMode and a non-4 case version', () => {
    const a = makeSet()
    ;(a.cases[0] as { ragMode: string }).ragMode = 'hybrid'
    expect(() => validateBenchSet(a)).toThrow(/ragMode/)
    const b = makeSet()
    ;(b.cases[0] as { version: number }).version = 3
    expect(() => validateBenchSet(b)).toThrow(/expected 4.*version/)
  })

  it('accepts null runs and round-trips them', () => {
    const set = makeSet({ runs: { current: null, previous: null } })
    expect(importBenchSet(exportBenchSet(set))).toEqual(set)
  })

  it('rejects a malformed run score (RowResult) with the field path', () => {
    const set = makeSet()
    // score should be a RowResult — make `excluded` a non-boolean.
    ;(set.runs.current!.scores['case-1'] as { excluded: unknown }).excluded = 'nope'
    expect(() => validateBenchSet(set)).toThrow(BenchSetValidationError)
    expect(() => validateBenchSet(set)).toThrow(/expected boolean.*scores\.case-1\.excluded/)
  })

  it('rejects a malformed run score field-result state', () => {
    const set = makeSet()
    set.runs.current!.scores['case-1'].fields = [
      { field: 'prose', scorer: 'reference-judge', score: 1, state: 'bogus' as never },
    ]
    expect(() => validateBenchSet(set)).toThrow(/unknown field-result state "bogus"/)
  })

  it('rejects malformed capturedGrounding in a run output (no silent partial state)', () => {
    const set = makeSet()
    ;(set.runs.current!.outputs['case-1'].capturedGrounding as { mode: string }).mode = 'hybrid'
    expect(() => validateBenchSet(set)).toThrow(/capturedGrounding\.mode/)
    const set2 = makeSet()
    ;(
      set2.runs.current!.outputs['case-1'].capturedGrounding.chunks![0] as { distance: unknown }
    ).distance = 'near'
    expect(() => validateBenchSet(set2)).toThrow(/expected number.*chunks\[0\]\.distance/)
  })
})

// ── quota: pre-flight + QuotaExceededError ───────────────────────────────────

describe('localStorage quota (pre-flight + QuotaExceededError handling)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pre-flight reports ok for a small store', () => {
    const pf = preflightQuota(BENCH_KEY, JSON.stringify(makeSet()))
    expect(pf.ok).toBe(true)
    expect(pf.budgetBytes).toBe(LOCALSTORAGE_BUDGET_BYTES)
    expect(pf.projectedBytes).toBeGreaterThan(0)
  })

  it('pre-flight reports NOT ok when the projected size blows the budget', () => {
    const huge = 'x'.repeat(LOCALSTORAGE_BUDGET_BYTES) // ~5M chars
    const pf = preflightQuota(BENCH_KEY, huge)
    expect(pf.ok).toBe(false)
  })

  it('a real QuotaExceededError surfaces as a typed BenchQuotaExceededError (no silent loss)', () => {
    const set = makeSet()
    saveBenchSet(set)
    const before = localStorage.getItem(BENCH_KEY)
    // Simulate a full store: the next write throws the DOM quota error.
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      const e = new DOMException('full', 'QuotaExceededError')
      throw e
    })
    expect(() => persistStore(loadBenchStore())).toThrow(BenchQuotaExceededError)
    spy.mockRestore()
    // setItem is atomic — the prior value is intact (completed work retained).
    expect(localStorage.getItem(BENCH_KEY)).toBe(before)
  })
})

// ── set-completion (export-prompt moment, design #9) ─────────────────────────

describe('set-completion (export prompted at completion moments)', () => {
  it('a fully-scored set is complete', () => {
    expect(setCompletion(makeSet()).complete).toBe(true)
  })

  it('an unscored set is not complete', () => {
    const set = makeSet({ runs: { current: null, previous: null } })
    const c = setCompletion(set)
    expect(c.complete).toBe(false)
    expect(c.scored).toBe(0)
    expect(c.total).toBe(1)
  })
})

// ── store CRUD ───────────────────────────────────────────────────────────────

describe('BenchSet store CRUD', () => {
  it('upserts by id and deletes', () => {
    saveBenchSet(makeSet())
    saveBenchSet(makeSet({ name: 'Renamed' }))
    expect(loadBenchSets()).toHaveLength(1)
    expect(getBenchSet('set-1')!.name).toBe('Renamed')
    deleteBenchSet('set-1')
    expect(loadBenchSets()).toHaveLength(0)
  })

  it('a corrupt store blob recovers to empty without throwing', () => {
    localStorage.setItem(BENCH_KEY, '{garbage')
    expect(loadBenchStore().sets).toEqual([])
  })

  it('keeps the VALID sets when one set in the store is corrupt (no full reset)', () => {
    const good = makeSet()
    // A structurally-invalid set sitting next to the good one (cases must be array).
    const bad = { ...makeSet({ id: 'bad', name: 'Bad' }), cases: 'nope' }
    localStorage.setItem(BENCH_KEY, JSON.stringify({ version: 4, sets: [good, bad] }))
    const sets = loadBenchStore().sets
    // One corrupt set must not discard the user's other sets.
    expect(sets.map((s) => s.id)).toEqual(['set-1'])
    expect(sets[0]).toEqual(good)
  })
})

// ── migration robustness: unmigratable legacy rows are skipped, not cast in raw ─

describe('migration validates legacy rows (no unvalidated cast into the store)', () => {
  it('skips a legacy v1 row that cannot form a valid v4 case; others still import', () => {
    const v1: UserCase[] = [
      { id: 'ok', patientId: 'p', query: 'q', mode: 'retrieve', createdAt: 1 },
      // missing query + createdAt → cannot form a v4 case that passes validation
      { id: 'bad', patientId: 'p', mode: 'retrieve' } as unknown as UserCase,
    ]
    const cases = buildMigratedCases(v1, [])
    expect(cases.map((c) => c.id)).toEqual(['ok'])
  })

  it('a migrated set survives a re-load (migration never poisons validateBenchSet)', () => {
    // A v1 row with a junk ragMode would, if cast in raw, fail the next load and
    // take the whole set down. It must be dropped at migration time instead.
    const v1: UserCase[] = [
      { id: 'good', patientId: 'p', query: 'q', mode: 'retrieve', createdAt: 1 },
      { id: 'junk', patientId: 'p', query: 'q', mode: 'hybrid' as never, createdAt: 1 },
    ]
    localStorage.setItem('user_cases_v1', JSON.stringify(v1))
    migrateLegacyToV4()
    // Re-load goes through full validation — the set must still be there with the
    // good case only (the junk row was never written).
    const set = getBenchSet('migrated-v4')!
    expect(set.cases.map((c) => c.id)).toEqual(['good'])
  })
})
