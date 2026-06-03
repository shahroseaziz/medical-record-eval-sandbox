import type { EvalCase, ContainsResult } from '../types'

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseItems(expectedOutput: string): string[] {
  return expectedOutput
    .split(/[\n,]+/)
    .map((s) => normalize(s))
    .filter((s) => s.length > 0)
}

export function scoreContains(evalCase: EvalCase): ContainsResult {
  if (evalCase.expectedOutput == null) {
    return {
      scorer: 'contains',
      score: null,
      errored: true,
      errorMessage: 'No expectedOutput provided',
      normalizedOutput: '',
      expectedItems: [],
      missingItems: [],
    }
  }

  const normalizedOutput = normalize(evalCase.output)
  const expectedItems = parseItems(evalCase.expectedOutput)
  const missingItems = expectedItems.filter((item) => !normalizedOutput.includes(item))
  const score: 0 | 1 = missingItems.length === 0 ? 1 : 0

  return {
    scorer: 'contains',
    score,
    normalizedOutput,
    expectedItems,
    missingItems,
  }
}
