import type { FieldResult, ScorerName } from './types'
import type { RowResult } from './row-aggregate'
import { rowScorers } from './row-aggregate'

export const DEFAULT_PASS_THRESHOLD = 0.85

/**
 * Scorer-agnostic result for one user-eval case.
 *
 * The canonical signals agreement reads are `score` (the row's roll-up score,
 * possibly composed from a MIX of scorers — see row-aggregate.ts) and `excluded`
 * (whether the row had nothing cleanly scoreable). Neither names a scorer, so a
 * row graded by structured-diff, by a judge, or by both flows through unchanged.
 *
 * The faithfulness-shaped fields (`faithfulnessScore`, `zeroClaimFlag`, `claims`)
 * are retained as OPTIONAL legacy detail: the prose/faithfulness path and the
 * persisted worked-example data still carry them, and runs already saved to a
 * user's localStorage predate the generalized fields. `caseScore` / `caseExcluded`
 * bridge both shapes, so old and new results aggregate side by side.
 */
export interface UserRunCaseResult {
  caseId: string
  intentLabel: 'pass' | 'fail'
  /** Canonical scorer-agnostic score in [0,1]; null when nothing was scoreable. */
  score?: number | null
  /** Canonical: excluded from the agreement denominator (nothing to grade). */
  excluded?: boolean
  output: string
  taskPrompt: string
  /** Per-field breakdown when the row was graded field-by-field (mixed scorers). */
  fields?: FieldResult[]
  /** Distinct scorers that contributed to `score` (provenance / display). */
  scorers?: ScorerName[]
  // ── Legacy faithfulness detail (optional; still written by the prose path) ──
  /** @deprecated faithfulness-specific alias for `score`. Read via `caseScore`. */
  faithfulnessScore?: number | null
  /** @deprecated faithfulness-specific alias for `excluded`. Read via `caseExcluded`. */
  zeroClaimFlag?: boolean
  /** Faithfulness claim detail — present only for faithfulness-judged prose. */
  claims?: Array<{
    claim: string
    verdict: 'supported' | 'unsupported' | 'partial'
    rationale: string
  }>
}

/**
 * Canonical score for a result, bridging the generalized (`score`) and legacy
 * faithfulness (`faithfulnessScore`) shapes. The generalized field wins when set.
 */
export function caseScore(c: UserRunCaseResult): number | null {
  return c.score !== undefined ? c.score : c.faithfulnessScore ?? null
}

/**
 * Whether a result is excluded from the agreement denominator, bridging the
 * generalized (`excluded`) and legacy faithfulness (`zeroClaimFlag`) shapes.
 */
export function caseExcluded(c: UserRunCaseResult): boolean {
  return c.excluded !== undefined ? c.excluded : c.zeroClaimFlag ?? false
}

/**
 * Build a scorer-agnostic case result from a rolled-up (possibly mixed-scorer)
 * row plus the case metadata agreement needs.
 */
export function toUserRunCaseResult(
  row: RowResult,
  meta: {
    intentLabel: 'pass' | 'fail'
    output: string
    taskPrompt: string
    claims?: UserRunCaseResult['claims']
  },
): UserRunCaseResult {
  return {
    caseId: row.caseId,
    intentLabel: meta.intentLabel,
    score: row.score,
    excluded: row.excluded,
    fields: row.fields,
    scorers: rowScorers(row.fields),
    output: meta.output,
    taskPrompt: meta.taskPrompt,
    claims: meta.claims,
  }
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
 * Directional agreement between scorer verdicts and user intent labels.
 *
 * Scorer-agnostic: reads each case's roll-up score and exclusion flag via the
 * `caseScore` / `caseExcluded` bridge, so diff-scored, judge-scored, and mixed
 * rows are treated identically. The score's origin is irrelevant here.
 *
 * Inclusion rules:
 * - Excluded cases (nothing scoreable: zero-claim / skipped / no score) are
 *   EXCLUDED from the denominator.
 * - Designed-fail cases (intentLabel='fail') are RETAINED in the denominator.
 * - A case agrees when score >= threshold AND intentLabel='pass',
 *   OR score < threshold AND intentLabel='fail'.
 *
 * Deliberately NOT a chance-corrected statistic: Cohen's κ (aggregate.ts) is for
 * the seeded judge-calibration set, not user evals. At user N (≈6-8 cases) κ is
 * unstable and would imply a rigor the sample cannot support, so directional
 * agreement is reported instead. κ is intentionally not imported here.
 */
export function computeUserAgreement(
  cases: UserRunCaseResult[],
  threshold: number,
): UserAgreementResult {
  const eligible = cases.filter((c) => !caseExcluded(c) && caseScore(c) !== null)
  const n = eligible.length
  const nExcluded = cases.length - n

  if (n === 0) return { agreement: null, n: 0, nExcluded, agreeCount: 0 }

  const agreeCount = eligible.filter((c) => {
    const judgePass = (caseScore(c) as number) >= threshold
    return (judgePass && c.intentLabel === 'pass') || (!judgePass && c.intentLabel === 'fail')
  }).length

  return { agreement: agreeCount / n, n, nExcluded, agreeCount }
}

export interface StoredEvalRun {
  timestamp: number
  threshold: number
  results: UserRunCaseResult[]
  /** Present when the run was stopped before all cases were scored. */
  partial?: {
    scored: number
    total: number
    rateLimited: boolean
  }
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
