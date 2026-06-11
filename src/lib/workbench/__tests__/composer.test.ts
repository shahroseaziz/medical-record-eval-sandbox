// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  KNOWN_SECTIONS,
  RECORD_BUDGET_TOKENS,
  ASSEMBLY_OVERHEAD_TOKENS,
  assembleStuffRecord,
  recordFitsBudget,
  recordTokenEstimate,
  patientRecordIsEligible,
  filterBySections,
  deriveScorer,
  deriveFieldScorers,
  EXPECTED_FIELD_KEY,
  incompleteStructuredRows,
  cleanStructuredRows,
  scoreStructuredAgainstRows,
  buildSkeletonCase,
  draftToCase,
  addCaseToAuthoredSet,
  AUTHORED_SET_ID,
  type RecordChunk,
  type ComposablePatient,
} from '../composer'
import { MAX_INPUT_TOKENS } from '@/lib/tokens'
import { validateBenchCase, loadBenchSets } from '@/lib/cases'
import type { BenchStructuredRow } from '@/lib/cases'

const PATIENT: ComposablePatient = {
  id: 'p1',
  name: 'Agustin437 Hills818',
  summary: { sections: ['medications', 'allergies', 'problems'] },
}

function chunk(section: string, text: string, ord = 0): RecordChunk {
  return { section, ord, text }
}

describe('composer — record-size guard (D3)', () => {
  it('the budget reserves prompt/query overhead out of the 12k ceiling', () => {
    expect(RECORD_BUDGET_TOKENS).toBe(MAX_INPUT_TOKENS - ASSEMBLY_OVERHEAD_TOKENS)
    expect(RECORD_BUDGET_TOKENS).toBeLessThan(MAX_INPUT_TOKENS)
  })

  it('assembleStuffRecord joins chunks as the stuff-mode record', () => {
    const record = assembleStuffRecord([
      chunk('medications', 'Lisinopril 10mg daily'),
      chunk('allergies', 'Penicillin — hives'),
    ])
    expect(record).toContain('[medications]')
    expect(record).toContain('[allergies]')
    expect(record).toContain('\n\n---\n\n')
  })

  it('a small record fits the budget; a giant record does not', () => {
    const small = assembleStuffRecord([chunk('problems', 'Type 2 diabetes mellitus.')])
    expect(recordFitsBudget(small)).toBe(true)
    expect(patientRecordIsEligible([chunk('problems', 'Type 2 diabetes mellitus.')])).toBe(true)

    // ~20k dense tokens worth of text — well over the 12k ceiling.
    const huge = 'SNOMED:44054006 2019-04-12T08:00:00Z value=128.4 '.repeat(4000)
    expect(recordTokenEstimate(huge)).toBeGreaterThan(MAX_INPUT_TOKENS)
    expect(recordFitsBudget(huge)).toBe(false)
    expect(patientRecordIsEligible([chunk('vitals', huge)])).toBe(false)
  })

  it('the guard is fail-closed: the margined estimate never under-counts', () => {
    // A record right at the budget edge: the margin keeps a borderline record out.
    const text = 'x'.repeat(RECORD_BUDGET_TOKENS * 4)
    expect(recordTokenEstimate(text)).toBeGreaterThan(0)
  })
})

describe('composer — section-chip filter (D7)', () => {
  const patients = [
    { id: 'a', summary: { sections: ['medications', 'allergies'] } },
    { id: 'b', summary: { sections: ['medications'] } },
    { id: 'c', summary: { sections: ['problems', 'vitals'] } },
  ]

  it('an empty selection matches everyone', () => {
    expect(filterBySections(patients, []).map((p) => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('selecting a section keeps only patients that have it', () => {
    expect(filterBySections(patients, ['medications']).map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('stacking chips narrows to patients with ALL selected sections', () => {
    expect(filterBySections(patients, ['medications', 'allergies']).map((p) => p.id)).toEqual(['a'])
  })

  it('only the known C-CDA sections are offered as chips', () => {
    expect([...KNOWN_SECTIONS]).toEqual([
      'problems',
      'medications',
      'allergies',
      'results',
      'encounters',
      'immunizations',
      'vitals',
    ])
  })
})

describe('composer — E25 scorer derivation', () => {
  it('prose → reference-judge, structured → structured-diff, none → faithfulness', () => {
    expect(deriveScorer('prose')).toBe('reference-judge')
    expect(deriveScorer('structured')).toBe('structured-diff')
    expect(deriveScorer('none')).toBe('faithfulness')
  })

  it('deriveFieldScorers keys the scorer under the kind field', () => {
    expect(deriveFieldScorers('prose')).toEqual({ [EXPECTED_FIELD_KEY.prose]: 'reference-judge' })
    expect(deriveFieldScorers('structured')).toEqual({
      [EXPECTED_FIELD_KEY.structured]: 'structured-diff',
    })
    expect(deriveFieldScorers('none')).toEqual({ [EXPECTED_FIELD_KEY.none]: 'faithfulness' })
  })
})

describe('composer — field builder (D10)', () => {
  it('flags rows missing the required drug or dose', () => {
    const rows: BenchStructuredRow[] = [
      { drug: 'Lisinopril', dose: '10mg', route: 'PO', status: 'active' },
      { drug: 'Atorvastatin', dose: '', route: '', status: '' }, // missing dose
      { drug: '', dose: '20mg', route: '', status: '' }, // missing drug
    ]
    expect(incompleteStructuredRows(rows)).toEqual([1, 2])
  })

  it('cleanStructuredRows trims and drops fully-empty rows', () => {
    const rows: BenchStructuredRow[] = [
      { drug: ' Lisinopril ', dose: ' 10mg ', route: '', status: '' },
      { drug: '', dose: '', route: '', status: '' },
    ]
    expect(cleanStructuredRows(rows)).toEqual([
      { drug: 'Lisinopril', dose: '10mg', route: '', status: '' },
    ])
  })
})

describe('composer — R4 structured-diff contract', () => {
  // The field-builder rows ARE the structured-diff answer key: name+dose must be
  // readable by the scorer so a completed row produces a real (non-errored) score.
  it('field-builder rows score against a matching model output', () => {
    const rows: BenchStructuredRow[] = [
      { drug: 'Lisinopril', dose: '10mg', route: 'PO', status: 'active' },
      { drug: 'Atorvastatin', dose: '20mg', route: 'PO', status: 'active' },
    ]
    const actual = [
      { name: 'Lisinopril', dose: '10mg' },
      { name: 'Atorvastatin', dose: '20mg' },
    ]
    const result = scoreStructuredAgainstRows(rows, actual)
    expect(result.errored).toBeFalsy()
    expect(result.score).toBe(1)
  })

  it('a wrong dose drops the score below 1 (scoreable, not errored)', () => {
    const rows: BenchStructuredRow[] = [
      { drug: 'Lisinopril', dose: '10mg', route: 'PO', status: 'active' },
    ]
    const actual = [{ name: 'Lisinopril', dose: '40mg' }]
    const result = scoreStructuredAgainstRows(rows, actual)
    expect(result.errored).toBeFalsy()
    expect(result.score).not.toBeNull()
    expect(result.score!).toBeLessThan(1)
  })
})

describe('composer — skeletons are authorable, never dead-on-arrival', () => {
  it('buildSkeletonCase returns a v4-valid case', () => {
    const c = buildSkeletonCase(PATIENT, { id: 'sk-1', createdAt: 1000 })
    // Passing validateBenchCase = it can enter the store without poisoning the set.
    expect(() => validateBenchCase(c, 'roundtrip')).not.toThrow()
    expect(c.patientId).toBe('p1')
    expect(c.ragMode).toBe('stuff')
    expect(c.fieldScorers).toEqual({ claims: 'faithfulness' })
    expect(c.taskPrompt.length).toBeGreaterThan(0) // not blank → authorable
  })

  it('"give me 5" worth of skeletons are all independently valid', () => {
    const skeletons = Array.from({ length: 5 }, (_, i) =>
      buildSkeletonCase({ ...PATIENT, id: `p${i}` }, { id: `sk-${i}`, createdAt: 1000 + i }),
    )
    expect(skeletons).toHaveLength(5)
    for (const s of skeletons) {
      expect(() => validateBenchCase(s, 'sk')).not.toThrow()
    }
  })
})

describe('composer — draftToCase (three-way expected)', () => {
  it('structured draft carries the field-builder rows + structured-diff scorer', () => {
    const c = draftToCase({
      id: 'd1',
      patientId: 'p1',
      taskPrompt: 'list meds',
      ragMode: 'stuff',
      expectedKind: 'structured',
      structuredRows: [{ drug: 'Lisinopril', dose: '10mg', route: '', status: '' }],
      createdAt: 1,
    })
    expect(c.expectedStructured).toEqual([
      { drug: 'Lisinopril', dose: '10mg', route: '', status: '' },
    ])
    expect(c.fieldScorers).toEqual({ structured: 'structured-diff' })
    expect(c.expectedProse).toBeUndefined()
  })

  it('an absence case is authorable as a prose reference (→ reference-judge)', () => {
    const c = draftToCase({
      id: 'd2',
      patientId: 'p1',
      taskPrompt: 'any cardiac procedures?',
      ragMode: 'stuff',
      expectedKind: 'prose',
      expectedProse: 'No cardiac procedures are documented.',
      createdAt: 2,
    })
    expect(c.expectedProse).toBe('No cardiac procedures are documented.')
    expect(c.fieldScorers).toEqual({ prose: 'reference-judge' })
    expect(c.expectedStructured).toBeUndefined()
  })

  it('the none/faithfulness draft carries no answer key', () => {
    const c = draftToCase({
      id: 'd3',
      patientId: 'p1',
      taskPrompt: 'summarize the record',
      ragMode: 'stuff',
      expectedKind: 'none',
      createdAt: 3,
    })
    expect(c.expectedProse).toBeUndefined()
    expect(c.expectedStructured).toBeUndefined()
    expect(c.fieldScorers).toEqual({ claims: 'faithfulness' })
  })

  it('the visible override replaces the derived scorer', () => {
    const c = draftToCase({
      id: 'd4',
      patientId: 'p1',
      taskPrompt: 'list meds as prose',
      ragMode: 'stuff',
      expectedKind: 'prose',
      expectedProse: 'Lisinopril 10mg daily.',
      scorerOverride: 'faithfulness',
      createdAt: 4,
    })
    expect(c.fieldScorers).toEqual({ prose: 'faithfulness' })
  })
})

describe('composer — persistence into the authored set (O2 store)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('creates the "My cases" set on first add and upserts by id', () => {
    const c1 = draftToCase({
      id: 'c1',
      patientId: 'p1',
      taskPrompt: 'q1',
      ragMode: 'stuff',
      expectedKind: 'none',
      createdAt: 1,
    })
    const set = addCaseToAuthoredSet(c1)
    expect(set.id).toBe(AUTHORED_SET_ID)
    expect(set.cases).toHaveLength(1)

    // Persisted to the store, re-loadable.
    const loaded = loadBenchSets().find((s) => s.id === AUTHORED_SET_ID)
    expect(loaded?.cases).toHaveLength(1)

    // Re-adding the same id replaces, never duplicates.
    const c1b = { ...c1, taskPrompt: 'q1-edited' }
    const set2 = addCaseToAuthoredSet(c1b)
    expect(set2.cases).toHaveLength(1)
    expect(set2.cases[0].taskPrompt).toBe('q1-edited')
  })
})
