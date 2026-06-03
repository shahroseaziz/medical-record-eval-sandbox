export interface FaithfulnessRunResult {
  score: number | null
  zeroClaimFlag?: boolean
}

/** Mean of valid (non-null, non-zero-claim) scores. Returns null if no valid scores. */
export function computeMeanScore(results: FaithfulnessRunResult[]): number | null {
  const valid = results.filter((r) => !r.zeroClaimFlag && r.score !== null).map((r) => r.score as number)
  if (valid.length === 0) return null
  return valid.reduce((a, b) => a + b, 0) / valid.length
}

/** Sample standard deviation of valid scores. Returns 0 for fewer than 2 valid scores. */
export function computeStdDev(results: FaithfulnessRunResult[]): number {
  const valid = results.filter((r) => !r.zeroClaimFlag && r.score !== null).map((r) => r.score as number)
  if (valid.length < 2) return 0
  const mean = valid.reduce((a, b) => a + b, 0) / valid.length
  const variance = valid.map((s) => (s - mean) ** 2).reduce((a, b) => a + b, 0) / (valid.length - 1)
  return Math.sqrt(variance)
}

/** Index into results of the run whose score is closest to the median of valid scores. */
export function medianRunIndex(results: FaithfulnessRunResult[]): number {
  const valid = results
    .map((r, i) => ({ score: r.score, zeroClaimFlag: r.zeroClaimFlag, i }))
    .filter((r) => !r.zeroClaimFlag && r.score !== null)
  if (valid.length === 0) return 0
  const sorted = [...valid].sort((a, b) => (a.score as number) - (b.score as number))
  const median = (sorted[Math.floor((sorted.length - 1) / 2)].score as number)
  let best = valid[0]
  for (const r of valid) {
    if (Math.abs((r.score as number) - median) < Math.abs((best.score as number) - median)) best = r
  }
  return best.i
}

export interface CaseAggregateInput {
  meanScore: number | null
  referenceLabel: 'pass' | 'fail'
  zeroClaimFlag: boolean
}

export interface AggregateResult {
  passRate: number | null
  judgeReferenceAgreement: number | null
  n: number
  note: string
}

const FAITHFULNESS_THRESHOLD = 0.85

/**
 * Compute aggregate pass rate and judge-reference agreement over faithfulness cases.
 * Zero-claim cases are excluded from the aggregate.
 * - passRate: fraction of cases where score >= threshold
 * - judgeReferenceAgreement: fraction where judge classification agrees with referenceLabel
 */
export function computeAggregate(cases: CaseAggregateInput[]): AggregateResult {
  const scoreable = cases.filter((c) => !c.zeroClaimFlag && c.meanScore !== null)
  const n = scoreable.length
  if (n === 0) return { passRate: null, judgeReferenceAgreement: null, n: 0, note: 'directional, n=6-8' }

  const passCount = scoreable.filter((c) => (c.meanScore as number) >= FAITHFULNESS_THRESHOLD).length
  const agreeCount = scoreable.filter((c) => {
    const modelPass = (c.meanScore as number) >= FAITHFULNESS_THRESHOLD
    return (modelPass && c.referenceLabel === 'pass') || (!modelPass && c.referenceLabel === 'fail')
  }).length

  return {
    passRate: passCount / n,
    judgeReferenceAgreement: agreeCount / n,
    n,
    note: 'directional, n=6-8',
  }
}
