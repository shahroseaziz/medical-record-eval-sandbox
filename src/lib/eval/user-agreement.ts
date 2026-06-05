export const DEFAULT_PASS_THRESHOLD = 0.85

export interface UserRunCaseResult {
  caseId: string
  intentLabel: 'pass' | 'fail'
  faithfulnessScore: number | null
  zeroClaimFlag: boolean
  claims: Array<{
    claim: string
    verdict: 'supported' | 'unsupported' | 'partial'
    rationale: string
  }>
  output: string
  taskPrompt: string
}

export interface UserAgreementResult {
  /** Fraction of eligible cases where judge verdict matches intentLabel. Null if no eligible cases. */
  agreement: number | null
  /** Cases in denominator — zero-claim excluded, designed-fail retained. */
  n: number
  /** Cases excluded (zero-claim only). */
  nExcluded: number
  /** Raw agreeing count. */
  agreeCount: number
}

/**
 * Directional agreement between judge verdicts and user intent labels.
 *
 * Inclusion rules:
 * - Zero-claim cases (zeroClaimFlag=true) are EXCLUDED from denominator.
 * - Designed-fail cases (intentLabel='fail') are RETAINED in denominator.
 * - A case agrees when score >= threshold AND intentLabel='pass',
 *   OR score < threshold AND intentLabel='fail'.
 */
export function computeUserAgreement(
  cases: UserRunCaseResult[],
  threshold: number,
): UserAgreementResult {
  const eligible = cases.filter((c) => !c.zeroClaimFlag && c.faithfulnessScore !== null)
  const n = eligible.length
  const nExcluded = cases.length - n

  if (n === 0) return { agreement: null, n: 0, nExcluded, agreeCount: 0 }

  const agreeCount = eligible.filter((c) => {
    const judgePass = (c.faithfulnessScore as number) >= threshold
    return (judgePass && c.intentLabel === 'pass') || (!judgePass && c.intentLabel === 'fail')
  }).length

  return { agreement: agreeCount / n, n, nExcluded, agreeCount }
}

export interface StoredEvalRun {
  timestamp: number
  threshold: number
  results: UserRunCaseResult[]
}

const STORAGE_KEY_EVAL_RUN = 'user_eval_run_v1'

export function loadStoredEvalRun(): StoredEvalRun | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EVAL_RUN)
    if (!raw) return null
    return JSON.parse(raw) as StoredEvalRun
  } catch {
    return null
  }
}

export function saveEvalRun(run: StoredEvalRun): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY_EVAL_RUN, JSON.stringify(run))
}
