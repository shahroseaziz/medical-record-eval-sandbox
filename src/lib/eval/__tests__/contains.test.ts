import { describe, it, expect } from 'vitest'
import { scoreContains } from '../scorers/contains'
import type { EvalCase } from '../types'

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-1',
    patientId: 'p1',
    query: 'What medications?',
    output: 'The patient takes Lisinopril and Metformin daily.',
    mode: 'retrieve',
    ...overrides,
  }
}

describe('scoreContains', () => {
  it('returns score 1 when all expected items are present', () => {
    const result = scoreContains(
      makeCase({ expectedOutput: 'Lisinopril, Metformin' })
    )
    expect(result.score).toBe(1)
    expect(result.missingItems).toEqual([])
    expect(result.errored).toBeUndefined()
  })

  it('returns score 0 when any expected item is missing', () => {
    const result = scoreContains(
      makeCase({ expectedOutput: 'Lisinopril, Atorvastatin' })
    )
    expect(result.score).toBe(0)
    expect(result.missingItems).toContain('atorvastatin')
  })

  it('normalizes case and punctuation before comparison', () => {
    const result = scoreContains(
      makeCase({
        output: 'The patient has LISINOPRIL, metformin!',
        expectedOutput: 'lisinopril\nmetformin',
      })
    )
    expect(result.score).toBe(1)
    expect(result.missingItems).toEqual([])
  })

  it('parses newline-delimited items', () => {
    const result = scoreContains(
      makeCase({ expectedOutput: 'lisinopril\nmetformin' })
    )
    expect(result.expectedItems).toEqual(['lisinopril', 'metformin'])
    expect(result.score).toBe(1)
  })

  it('parses comma-delimited items', () => {
    const result = scoreContains(
      makeCase({ expectedOutput: 'lisinopril, metformin' })
    )
    expect(result.expectedItems).toEqual(['lisinopril', 'metformin'])
  })

  it('parses mixed newline+comma delimiters', () => {
    const result = scoreContains(
      makeCase({ expectedOutput: 'lisinopril\nmetformin, daily' })
    )
    expect(result.expectedItems).toContain('lisinopril')
    expect(result.expectedItems).toContain('metformin')
    expect(result.expectedItems).toContain('daily')
  })

  it('strips punctuation from expected items before comparison', () => {
    const result = scoreContains(
      makeCase({ expectedOutput: 'Lisinopril!' })
    )
    expect(result.score).toBe(1)
  })

  it('returns errored when expectedOutput is missing', () => {
    const result = scoreContains(makeCase({ expectedOutput: undefined }))
    expect(result.score).toBeNull()
    expect(result.errored).toBe(true)
    expect(result.errorMessage).toBeTruthy()
  })

  it('returns score 0 with all items flagged missing when output is empty', () => {
    const result = scoreContains(
      makeCase({ output: '', expectedOutput: 'lisinopril' })
    )
    expect(result.score).toBe(0)
    expect(result.missingItems).toEqual(['lisinopril'])
  })

  it('collapses extra whitespace in normalized output', () => {
    const result = scoreContains(
      makeCase({
        output: 'Takes   lisinopril   and   metformin',
        expectedOutput: 'lisinopril and metformin',
      })
    )
    expect(result.score).toBe(1)
  })
})
