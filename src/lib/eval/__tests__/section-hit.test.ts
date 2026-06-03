import { describe, it, expect } from 'vitest'
import { scoreSectionHit } from '../scorers/section-hit'
import type { EvalCase } from '../types'

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-1',
    patientId: 'p1',
    query: 'What medications?',
    output: 'Patient takes Lisinopril.',
    mode: 'retrieve',
    k: 6,
    retrievedChunks: [
      { section: 'medications', text: 'Lisinopril 10mg' },
      { section: 'problems', text: 'Hypertension' },
      { section: 'allergies', text: 'NKDA' },
    ],
    ...overrides,
  }
}

describe('scoreSectionHit', () => {
  it('all required sections present -> score 1', () => {
    const result = scoreSectionHit(
      makeCase({ requiredSections: ['medications', 'problems'] })
    )
    expect(result.score).toBe(1)
    expect(result.missingSections).toEqual([])
  })

  it('one required section missing -> score 0', () => {
    const result = scoreSectionHit(
      makeCase({ requiredSections: ['medications', 'results'] })
    )
    expect(result.score).toBe(0)
    expect(result.missingSections).toContain('results')
  })

  it('requiredSections.length > k -> throws config-mismatch error', () => {
    expect(() =>
      scoreSectionHit(
        makeCase({
          k: 2,
          requiredSections: ['medications', 'problems', 'allergies'],
        })
      )
    ).toThrow(/config mismatch/i)
  })

  it('stuff mode -> score is null regardless of chunks', () => {
    const result = scoreSectionHit(
      makeCase({
        mode: 'stuff',
        record: 'some record',
        requiredSections: ['medications'],
      })
    )
    expect(result.score).toBeNull()
    expect(result.missingSections).toEqual([])
  })

  it('surfaces the retrieved and required sections in result', () => {
    const result = scoreSectionHit(
      makeCase({ requiredSections: ['medications'] })
    )
    expect(result.retrievedSections).toContain('medications')
    expect(result.requiredSections).toEqual(['medications'])
  })

  it('no requiredSections -> score 1 (nothing required, nothing missing)', () => {
    const result = scoreSectionHit(makeCase({ requiredSections: [] }))
    expect(result.score).toBe(1)
    expect(result.missingSections).toEqual([])
  })

  it('requiredSections equal to k is valid (boundary)', () => {
    expect(() =>
      scoreSectionHit(
        makeCase({
          k: 3,
          requiredSections: ['medications', 'problems', 'allergies'],
        })
      )
    ).not.toThrow()
  })
})
