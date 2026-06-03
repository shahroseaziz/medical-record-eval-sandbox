// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadUserCases,
  saveUserCase,
  deleteUserCase,
  aggregateSeededCases,
  type UserCase,
  type SeededCase,
} from '../cases'

const SEED_CASES: SeededCase[] = [
  {
    id: 'seed-1',
    patientId: 'p001',
    query: 'What medications is the patient taking?',
    mode: 'retrieve',
    referenceLabel: 'med-query-v1',
    requiredSections: ['medications'],
    rationale: 'Tests medication retrieval',
  },
  {
    id: 'seed-2',
    patientId: 'p002',
    query: 'List all known allergies.',
    mode: 'stuff',
    referenceLabel: 'allergy-query-v1',
    requiredSections: [],
    rationale: 'Tests full-record stuffing',
    expectedOutput: 'penicillin',
    record: 'Allergy: penicillin',
  },
]

const makeUserCase = (id: string): UserCase => ({
  id,
  patientId: 'p-user',
  query: 'Any recent lab results?',
  mode: 'retrieve',
  createdAt: Date.now(),
})

describe('UserCase localStorage CRUD', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts empty', () => {
    expect(loadUserCases()).toHaveLength(0)
  })

  it('saves and loads a case', () => {
    const uc = makeUserCase('u-1')
    saveUserCase(uc)
    const loaded = loadUserCases()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('u-1')
    expect(loaded[0].query).toBe(uc.query)
  })

  it('updates an existing case on re-save', () => {
    const uc = makeUserCase('u-2')
    saveUserCase(uc)
    saveUserCase({ ...uc, query: 'Updated query' })
    const loaded = loadUserCases()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].query).toBe('Updated query')
  })

  it('deletes a case', () => {
    saveUserCase(makeUserCase('u-3'))
    saveUserCase(makeUserCase('u-4'))
    deleteUserCase('u-3')
    const loaded = loadUserCases()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('u-4')
  })
})

describe('user-case exclusion: seeded aggregate is unaffected by localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('aggregateSeededCases returns correct stats for seeded set', () => {
    const agg = aggregateSeededCases(SEED_CASES)
    expect(agg.count).toBe(2)
    expect(agg.ids).toEqual(['seed-1', 'seed-2'])
    expect(agg.modeBreakdown.retrieve).toBe(1)
    expect(agg.modeBreakdown.stuff).toBe(1)
    expect(agg.withExpectedOutput).toBe(1)
  })

  it('saving a user case to localStorage does NOT alter the seeded aggregate', () => {
    const before = aggregateSeededCases(SEED_CASES)

    // Simulate a user saving multiple cases
    saveUserCase(makeUserCase('u-x1'))
    saveUserCase(makeUserCase('u-x2'))
    saveUserCase({ ...makeUserCase('u-x3'), mode: 'stuff', expectedOutput: 'some expected' })

    // User cases exist in localStorage
    expect(loadUserCases()).toHaveLength(3)

    // The seeded aggregate is identical — aggregateSeededCases is a pure function
    const after = aggregateSeededCases(SEED_CASES)
    expect(after).toEqual(before)
    expect(after.count).toBe(2)
    expect(after.withExpectedOutput).toBe(1)
  })

  it('deleting all user cases does NOT change the seeded aggregate', () => {
    saveUserCase(makeUserCase('u-y'))
    deleteUserCase('u-y')

    const agg = aggregateSeededCases(SEED_CASES)
    expect(agg.count).toBe(2)
  })

  it('empty seed set produces zero aggregate', () => {
    const agg = aggregateSeededCases([])
    expect(agg.count).toBe(0)
    expect(agg.ids).toEqual([])
    expect(agg.modeBreakdown.retrieve).toBe(0)
    expect(agg.modeBreakdown.stuff).toBe(0)
  })
})
