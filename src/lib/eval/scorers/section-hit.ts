import type { EvalCase, SectionHitResult } from '../types'

export function scoreSectionHit(evalCase: EvalCase): SectionHitResult {
  const requiredSections = evalCase.requiredSections ?? []
  const retrievedSections = (evalCase.retrievedChunks ?? []).map((c) => c.section)

  if (evalCase.mode === 'stuff') {
    return {
      scorer: 'section-hit',
      score: null,
      requiredSections,
      retrievedSections,
      missingSections: [],
    }
  }

  const k = evalCase.k ?? 6
  if (requiredSections.length > k) {
    throw new Error(
      `Config mismatch: requiredSections.length (${requiredSections.length}) > k (${k}). ` +
        `Cannot require more sections than the retrieval limit.`
    )
  }

  const missingSections = requiredSections.filter((s) => !retrievedSections.includes(s))
  const score: 0 | 1 = missingSections.length === 0 ? 1 : 0

  return {
    scorer: 'section-hit',
    score,
    requiredSections,
    retrievedSections,
    missingSections,
  }
}
