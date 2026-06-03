import type { EvalCase, ExtractionCompletenessResult } from '../types'

export function scoreExtractionCompleteness(
  evalCase: EvalCase,
  extractedClaims: string[]
): ExtractionCompletenessResult {
  if (!evalCase.expectedClaims || evalCase.expectedClaims.length === 0) {
    return {
      scorer: 'extraction-completeness',
      score: null,
      errored: true,
      errorMessage: 'No expectedClaims provided on case',
      expectedCount: 0,
      actualCount: extractedClaims.length,
      underExtractionFlagged: false,
    }
  }

  const expectedCount = evalCase.expectedClaims.length
  const actualCount = extractedClaims.length
  const underExtractionFlagged = actualCount < expectedCount
  const score = Math.min(1.0, actualCount / expectedCount)

  return {
    scorer: 'extraction-completeness',
    score,
    expectedCount,
    actualCount,
    underExtractionFlagged,
  }
}
