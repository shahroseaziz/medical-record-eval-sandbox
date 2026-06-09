import { describe, it, expect } from 'vitest'
import { scoreStructuredDiff, extractEntries } from '../scorers/structured-diff'
import type { EvalCase } from '../types'

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-1',
    patientId: 'p1',
    query: 'List medications',
    output: '',
    mode: 'stuff',
    ...overrides,
  }
}

const meds = (list: Array<{ name: string; dose?: string }>) => ({ medications: list })

describe('scoreStructuredDiff — field-level match/mismatch', () => {
  it('perfect match scores 1.0 with all fields matched', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Metformin', dose: '500 mg' }]) }),
      meds([{ name: 'Metformin', dose: '500 mg' }]),
    )
    expect(r.score).toBe(1)
    expect(r.matchCount).toBe(2) // name + dose
    expect(r.mismatchCount).toBe(0)
    expect(r.missingCount).toBe(0)
    expect(r.extraCount).toBe(0)
  })

  it('matches across unit and name aliases (normalization applied before diff)', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Metformin', dose: '0.5 g' }]) }),
      meds([{ name: 'Metformin HCl', dose: '500 mg' }]),
    )
    expect(r.score).toBe(1)
    expect(r.mismatchCount).toBe(0)
  })

  it('flags a dose mismatch as both false-pos and false-neg', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Metformin', dose: '500 mg' }]) }),
      meds([{ name: 'Metformin', dose: '1000 mg' }]),
    )
    expect(r.matchCount).toBe(1) // name matched
    expect(r.mismatchCount).toBe(1) // dose mismatched
    // mismatch counts against both precision and recall
    expect(r.precision).toBeCloseTo(0.5)
    expect(r.recall).toBeCloseTo(0.5)
    const dose = r.fields.find((f) => f.field === 'dose')
    expect(dose?.status).toBe('mismatch')
    expect(dose?.expected).toBe('500 mg')
    expect(dose?.actual).toBe('1000 mg')
  })
})

describe('scoreStructuredDiff — missing / extra semantics', () => {
  it('counts an expected-but-absent item as missing (false negative)', () => {
    const r = scoreStructuredDiff(
      makeCase({
        expectedStructured: meds([
          { name: 'Metformin', dose: '500 mg' },
          { name: 'Lisinopril', dose: '10 mg' },
        ]),
      }),
      meds([{ name: 'Metformin', dose: '500 mg' }]),
    )
    expect(r.missingCount).toBe(2) // Lisinopril name + dose
    expect(r.extraCount).toBe(0)
    const missing = r.fields.filter((f) => f.status === 'missing')
    expect(missing.map((f) => f.item)).toContain('lisinopril')
    // recall hit, precision intact
    expect(r.precision).toBe(1)
    expect(r.recall).toBeCloseTo(2 / 4)
  })

  it('counts an actual-only item as extra (false positive)', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Metformin', dose: '500 mg' }]) }),
      meds([
        { name: 'Metformin', dose: '500 mg' },
        { name: 'Aspirin', dose: '81 mg' },
      ]),
    )
    expect(r.extraCount).toBe(2) // Aspirin name + dose
    expect(r.missingCount).toBe(0)
    const extra = r.fields.filter((f) => f.status === 'extra')
    expect(extra.map((f) => f.item)).toContain('aspirin')
    expect(r.recall).toBe(1)
    expect(r.precision).toBeCloseTo(2 / 4)
  })

  it('handles a dose present on only one side', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Metformin', dose: '500 mg' }]) }),
      meds([{ name: 'Metformin' }]),
    )
    expect(r.matchCount).toBe(1) // name
    expect(r.missingCount).toBe(1) // dose missing from actual
    const dose = r.fields.find((f) => f.field === 'dose')
    expect(dose?.status).toBe('missing')
    expect(dose?.expected).toBe('500 mg')
  })
})

describe('scoreStructuredDiff — duplicate / blind spots', () => {
  it('surfaces multi-strength duplicate names as a blind spot', () => {
    const r = scoreStructuredDiff(
      makeCase({
        expectedStructured: meds([
          { name: 'Metformin', dose: '500 mg' },
          { name: 'Metformin', dose: '1000 mg' },
        ]),
      }),
      meds([
        { name: 'Metformin', dose: '500 mg' },
        { name: 'Metformin', dose: '1000 mg' },
      ]),
    )
    expect(r.score).toBe(1)
    expect(r.blindSpots.some((b) => b.includes('multiple strengths'))).toBe(true)
  })

  it('surfaces an unparseable dose as a blind spot, comparing as text', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Warfarin', dose: 'as directed' }]) }),
      meds([{ name: 'Warfarin', dose: 'As Directed' }]),
    )
    expect(r.matchCount).toBe(2) // name + dose-as-text
    expect(r.blindSpots.some((b) => b.includes('not parseable'))).toBe(true)
  })
})

describe('scoreStructuredDiff — input handling', () => {
  it('errors when expectedStructured is absent', () => {
    const r = scoreStructuredDiff(makeCase({ expectedStructured: undefined }), meds([]))
    expect(r.score).toBeNull()
    expect(r.errored).toBe(true)
    expect(r.errorMessage).toBeTruthy()
  })

  it('parses actual from output JSON when no parsed actual is supplied', () => {
    const r = scoreStructuredDiff(
      makeCase({
        expectedStructured: meds([{ name: 'Metformin', dose: '500 mg' }]),
        output: JSON.stringify(meds([{ name: 'Metformin', dose: '500 mg' }])),
      }),
    )
    expect(r.score).toBe(1)
  })

  it('errors when output is not valid JSON and no actual supplied', () => {
    const r = scoreStructuredDiff(
      makeCase({
        expectedStructured: meds([{ name: 'Metformin' }]),
        output: 'not json',
      }),
    )
    expect(r.errored).toBe(true)
  })

  it('scores an empty-expected / empty-actual case as a perfect true negative', () => {
    const r = scoreStructuredDiff(makeCase({ expectedStructured: meds([]) }), meds([]))
    expect(r.errored).toBeFalsy()
    expect(r.score).toBe(1)
    expect(r.precision).toBe(1)
    expect(r.recall).toBe(1)
    expect(r.matchCount).toBe(0)
    expect(r.blindSpots.some((b) => b.includes('true-negative'))).toBe(true)
  })

  it('penalizes producing meds when none were expected (false positives)', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([]) }),
      meds([{ name: 'Aspirin', dose: '81 mg' }]),
    )
    expect(r.errored).toBeFalsy()
    expect(r.score).toBe(0)
    expect(r.extraCount).toBe(2)
    expect(r.missingCount).toBe(0)
  })
})

describe('scoreStructuredDiff — salt / compound blind spots', () => {
  it('does NOT merge distinct electrolyte salts (potassium chloride vs citrate)', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Potassium chloride', dose: '20 meq' }]) }),
      meds([{ name: 'Potassium citrate', dose: '20 meq' }]),
    )
    // Distinct names → expected missing + actual extra, NOT a name match.
    expect(r.matchCount).toBe(0)
    const names = r.fields.filter((f) => f.field === 'name').map((f) => f.item)
    expect(names).toContain('potassium chloride')
    expect(names).toContain('potassium citrate')
  })

  it('surfaces a salt strip that altered a name as a blind spot', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Metformin', dose: '500 mg' }]) }),
      meds([{ name: 'Metformin HCl', dose: '500 mg' }]),
    )
    expect(r.score).toBe(1) // still matches (intended salt resolution)
    expect(r.blindSpots.some((b) => b.includes('salt-normalized') && b.includes('hcl'))).toBe(true)
  })

  it('surfaces an un-converted compound-unit comparison as a blind spot', () => {
    const r = scoreStructuredDiff(
      makeCase({ expectedStructured: meds([{ name: 'Heparin', dose: '10 mg/mL' }]) }),
      meds([{ name: 'Heparin', dose: '1 g/100mL' }]),
    )
    // Magnitudes are not converted across the slash → dose mismatch, surfaced.
    const dose = r.fields.find((f) => f.field === 'dose')
    expect(dose?.status).toBe('mismatch')
    expect(r.blindSpots.some((b) => b.includes('compound/concentration unit'))).toBe(true)
  })
})

describe('extractEntries — list shape tolerance', () => {
  it('reads a bare array', () => {
    expect(extractEntries([{ name: 'Metformin', dose: '500 mg' }])).toHaveLength(1)
  })

  it('reads a recognized list field', () => {
    expect(extractEntries({ medications: [{ name: 'A' }, { name: 'B' }] })).toHaveLength(2)
  })

  it('reads the single array-valued field', () => {
    expect(extractEntries({ stuff: [{ name: 'A' }] })).toHaveLength(1)
  })

  it('reads field aliases for name and dose', () => {
    const e = extractEntries([{ drug: 'Metformin', strength: '500 mg' }])
    expect(e[0].name).toBe('Metformin')
    expect(e[0].dose).toBe('500 mg')
  })

  it('reads string items', () => {
    expect(extractEntries({ medications: ['Metformin', 'Lisinopril'] })).toHaveLength(2)
  })

  it('treats a lone object as a single entry', () => {
    expect(extractEntries({ name: 'Metformin', dose: '500 mg' })).toHaveLength(1)
  })
})
