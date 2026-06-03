import { describe, it, expect } from 'vitest'
import { scoreExtractionCompleteness } from '../scorers/extraction-completeness'
import type { EvalCase } from '../types'

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-1',
    patientId: 'p1',
    query: 'Summarize the patient.',
    output: 'Patient has hypertension.',
    mode: 'retrieve',
    ...overrides,
  }
}

describe('scoreExtractionCompleteness', () => {
  it('flags under-extraction when actual < expected count', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: ['claim1', 'claim2', 'claim3'] }),
      ['claim1']
    )
    expect(result.underExtractionFlagged).toBe(true)
    expect(result.actualCount).toBe(1)
    expect(result.expectedCount).toBe(3)
  })

  it('does not flag when actual >= expected count', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: ['claim1', 'claim2'] }),
      ['claim1', 'claim2', 'claim3']
    )
    expect(result.underExtractionFlagged).toBe(false)
  })

  it('score equals actual/expected ratio', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: ['a', 'b', 'c', 'd'] }),
      ['a', 'b']
    )
    expect(result.score).toBeCloseTo(0.5)
  })

  it('score is capped at 1.0 when actual > expected', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: ['a', 'b'] }),
      ['a', 'b', 'c', 'd']
    )
    expect(result.score).toBe(1.0)
  })

  it('returns errored when no expectedClaims provided', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: undefined }),
      ['claim1']
    )
    expect(result.score).toBeNull()
    expect(result.errored).toBe(true)
    expect(result.errorMessage).toBeTruthy()
  })

  it('returns errored when expectedClaims is empty', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: [] }),
      ['claim1']
    )
    expect(result.score).toBeNull()
    expect(result.errored).toBe(true)
  })

  it('surfaces actual and expected counts', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: ['a', 'b'] }),
      ['a']
    )
    expect(result.expectedCount).toBe(2)
    expect(result.actualCount).toBe(1)
  })

  it('exact match -> score 1.0, not flagged', () => {
    const result = scoreExtractionCompleteness(
      makeCase({ expectedClaims: ['a', 'b'] }),
      ['x', 'y']
    )
    expect(result.score).toBe(1.0)
    expect(result.underExtractionFlagged).toBe(false)
  })
})
