import type { FieldResult, FieldResultState, ScorerName } from './types'
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
  /**
   * Row-level state rolled up from the per-field results (see row-aggregate.ts).
   * This is the AUTHORITATIVE verdict for a field-graded row: each field was
   * classified against its own scorer's configured threshold, so the row's
   * matched/mismatched verdict must NOT be re-derived from the row mean against a
   * single global threshold. Absent on legacy faithfulness results (`caseVerdict`
   * falls back to score-vs-threshold there). See `caseVerdict`.
   */
  state?: FieldResultState
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
    state: row.state,
    output: meta.output,
    taskPrompt: meta.taskPrompt,
    claims: meta.claims,
  }
}

/**
 * Whether the global pass-threshold slider applies to this result's verdict.
 *
 * The slider is a FAITHFULNESS-calibration control: it answers "what faithfulness
 * cutoff best matches my labels?". It is meaningful only for rows whose verdict is
 * a single faithfulness score against one threshold — i.e. legacy results (no
 * per-field `state`) and pure-faithfulness field rows. A row graded by
 * structured-diff or a reference judge (or any mix) was classified field-by-field
 * against per-scorer config thresholds; sliding one global threshold over its mean
 * would override those and is incoherent, so such rows read their frozen `state`.
 */
function isThresholdCalibratable(c: UserRunCaseResult): boolean {
  if (c.state === undefined) return true
  const scorers = c.scorers ?? []
  return scorers.length > 0 && scorers.every((s) => s === 'faithfulness')
}

/**
 * The pass/fail verdict for one result, or null when it is excluded (nothing
 * cleanly scoreable). This is the single source of truth shared by the agreement
 * metric and the disagreement table, so the two can never diverge.
 *
 * - Field-graded, non-faithfulness/mixed rows: read the authoritative roll-up
 *   `state` (matched→pass, mismatched→fail). The threshold argument is ignored —
 *   per-field thresholds already decided this at scoring time.
 * - Legacy / pure-faithfulness rows: compare the score to `threshold` so the
 *   calibration slider keeps working.
 */
export function caseVerdict(
  c: UserRunCaseResult,
  threshold: number,
): 'pass' | 'fail' | null {
  if (caseExcluded(c)) return null
  if (!isThresholdCalibratable(c) && c.state !== undefined) {
    if (c.state === 'matched') return 'pass'
    if (c.state === 'mismatched') return 'fail'
    return null
  }
  const score = caseScore(c)
  if (score === null) return null
  return score >= threshold ? 'pass' : 'fail'
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
 * - Excluded cases (nothing scoreable: zero-claim / skipped / judge-errored /
 *   rate-limited / no score) are EXCLUDED from the denominator.
 * - Designed-fail cases (intentLabel='fail') are RETAINED in the denominator.
 * - A case agrees when its verdict (see `caseVerdict`) equals its intentLabel.
 *   The verdict honors a field-graded row's roll-up `state` and only falls back
 *   to score-vs-threshold for legacy / pure-faithfulness rows, so a mixed row's
 *   per-field classification is never overridden by the global threshold.
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
    const verdict = caseVerdict(c, threshold)
    return verdict !== null && verdict === c.intentLabel
  }).length

  return { agreement: agreeCount / n, n, nExcluded, agreeCount }
}

// ── User-label agreement (the G5 "judge agrees with the clinician" metric, E26) ─

/**
 * The user-path agreement metric (E26 / design G5). DISTINCT from
 * `computeUserAgreement` above: that one reads each case's authored `intentLabel`
 * (the designed pass/fail baked into the golden set). THIS one reads the user's
 * own pass/fail labels — a separate artifact the clinician marks on *scored
 * outputs* at disagreement review, persisted independently of runs in
 * `BenchSet.labels`. Only labeled cases enter the metric, so it answers "where the
 * judge and the clinician's own verdicts disagree", not "where the judge disagrees
 * with the case's design".
 *
 * - `populated` is false until the user has labeled ≥1 output. An unpopulated
 *   metric NEVER renders as a vacuous 100% (adversarial-review amendment): the
 *   surface shows the "label an output to populate this" empty state instead.
 * - Inclusion rules mirror `computeUserAgreement`: zero-claim / non-scoreable
 *   labeled cases are EXCLUDED from the denominator (E11, faithfulness path);
 *   designed-fail labels ('fail') are RETAINED. Scorer-agnostic via `caseVerdict`.
 * - `disagreers` lists the labeled cases whose judge verdict ≠ the user's label,
 *   so the disagreeing cases are "one click away".
 *
 * Still NOT chance-corrected: κ is never labeled on the user path (E21/E26) — at
 * user N the statistic is unstable, so directional agreement is reported.
 */
export interface LabelAgreementResult {
  /** False until ≥1 user label exists — drives the "unpopulated" empty state. */
  populated: boolean
  /** Fraction of labeled, scoreable cases where the judge verdict matches the user label; null when none scoreable. */
  agreement: number | null
  /** Labeled cases in the denominator (zero-claim excluded, designed-fail retained). */
  n: number
  /** Labeled cases excluded (nothing scoreable). */
  nExcluded: number
  /** Raw agreeing count. */
  agreeCount: number
  /** Case ids where the judge verdict disagrees with the user's label (one click away). */
  disagreers: string[]
}

export function computeLabelAgreement(
  cases: UserRunCaseResult[],
  labels: Record<string, 'pass' | 'fail'>,
  threshold: number,
): LabelAgreementResult {
  // Only cases the user has actually labeled enter the metric.
  const labeled = cases.filter((c) => labels[c.caseId] !== undefined)
  if (labeled.length === 0) {
    return { populated: false, agreement: null, n: 0, nExcluded: 0, agreeCount: 0, disagreers: [] }
  }

  const eligible = labeled.filter((c) => !caseExcluded(c) && caseScore(c) !== null)
  const n = eligible.length
  const nExcluded = labeled.length - n

  const disagreers: string[] = []
  let agreeCount = 0
  for (const c of eligible) {
    const verdict = caseVerdict(c, threshold)
    if (verdict === null) continue
    if (verdict === labels[c.caseId]) agreeCount++
    else disagreers.push(c.caseId)
  }

  return {
    populated: true,
    agreement: n === 0 ? null : agreeCount / n,
    n,
    nExcluded,
    agreeCount,
    disagreers,
  }
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
