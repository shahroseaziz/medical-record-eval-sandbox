// Mixed-row roll-up: compose a single eval row whose fields are graded by
// DIFFERENT scorers (e.g. a structured field by structured-diff and a prose
// field by a judge) into one row-level result.
//
// This is deliberately NET-NEW rather than an extension of aggregate.ts:
// aggregate.ts is faithfulness-shaped (mean-of-runs, kappa, zero-claim) and
// models repeated runs of ONE scorer over a case. A row here is the orthogonal
// axis — ONE run, MANY fields, MANY scorers — so it gets its own module.

import type {
  ExpectedField,
  FieldResult,
  FieldResultState,
  ScorerName,
} from './types'
import type { Thresholds } from './thresholds'

/** LLM-judge scorers — the only scorers whose failure is a `judge-errored` state. */
const JUDGE_SCORERS: ReadonlySet<ScorerName> = new Set<ScorerName>([
  'faithfulness',
  'reference-judge',
])

/**
 * Raw outcome of running one field's assigned scorer, before classification.
 * The fields are mutually-exclusive signals the caller already knows from the
 * scorer result / transport layer; classifyField turns them into one state.
 */
export interface FieldScoreOutcome {
  field: ExpectedField
  scorer: ScorerName
  /** Scorer score in [0,1]; null when no score was produced. */
  score: number | null
  /** A judge scorer threw / produced no verdict (non-rate-limit). */
  errored?: boolean
  /** Scoring was throttled (HTTP 429) before a verdict was produced. */
  rateLimited?: boolean
  /** Nothing to grade: no expected value or no scorer assigned for this field. */
  skipped?: boolean
  /** Faithfulness zero-claim: a score exists (1.0) but is excluded from aggregates. */
  zeroClaimFlag?: boolean
}

/**
 * Resolve the matched/mismatched cut-off for a scorer from the threshold config.
 * Pure — takes a plain Thresholds object so it runs client-side (loadThresholds
 * reads the filesystem and is server-only). Binary scorers (section-hit) have no
 * configured threshold, so a perfect score (1.0) is required to count as matched.
 */
export function scorerThreshold(scorer: ScorerName, thresholds: Thresholds): number {
  switch (scorer) {
    case 'contains':
      return thresholds.contains
    case 'faithfulness':
      return thresholds.faithfulness
    case 'reference-judge':
      return thresholds.referenceJudge
    case 'extraction-completeness':
      return thresholds.extractionCompleteness
    case 'structured-diff':
      return thresholds.structuredDiff
    case 'section-hit':
      return 1.0
    default: {
      // Exhaustiveness guard: a new ScorerName must declare its threshold here.
      const _never: never = scorer
      return _never
    }
  }
}

/**
 * Classify one field's scoring outcome into a per-field state.
 *
 * Precedence (most-blocking first): rate-limited → judge-errored → skipped →
 * matched/mismatched. A throttled or errored field is indeterminate, so it wins
 * over any partial score that may also be present.
 *
 * `threshold` is the score the field must MEET (>=) to count as matched.
 */
export function classifyField(outcome: FieldScoreOutcome, threshold: number): FieldResult {
  const { field, scorer, score } = outcome

  let state: FieldResultState
  if (outcome.rateLimited) {
    state = 'rate-limited'
  } else if (outcome.errored && JUDGE_SCORERS.has(scorer)) {
    state = 'judge-errored'
  } else if (outcome.skipped || outcome.zeroClaimFlag || score === null) {
    // Nothing to grade (no expected value / zero-claim), or a non-judge scorer
    // that produced no score. Either way it is excluded from aggregates.
    state = 'skipped'
  } else {
    state = score >= threshold ? 'matched' : 'mismatched'
  }

  // Only a cleanly-scored field carries a usable score downstream.
  const scoreable = state === 'matched' || state === 'mismatched'
  return { field, scorer, score: scoreable ? score : null, state }
}

/** The two states that carry a usable score and enter aggregate denominators. */
export function isScoreableState(state: FieldResultState): boolean {
  return state === 'matched' || state === 'mismatched'
}

export interface RowResult {
  caseId: string
  /** Per-field breakdown, in the order the fields were graded. */
  fields: FieldResult[]
  /** Mean of the scoreable field scores; null when no field was scoreable. */
  score: number | null
  /** Row-level state rolled up from the fields. */
  state: FieldResultState
  /**
   * True when the row must be excluded from the agreement denominator: it was
   * throttled, a judge errored, or nothing was scoreable. Only a row that is
   * cleanly matched/mismatched contributes to agreement.
   */
  excluded: boolean
}

/**
 * Roll a row's per-field results up into one row-level result.
 *
 * Row state precedence:
 *   1. any field rate-limited  → 'rate-limited'  (row is incomplete)
 *   2. any field judge-errored → 'judge-errored' (no verdict for part of the row)
 *   3. no scoreable field      → 'skipped'
 *   4. all scoreable matched   → 'matched'
 *   5. otherwise               → 'mismatched'
 *
 * The row score is the mean of the scoreable field scores only — skipped /
 * errored / rate-limited fields never dilute it. A mixed diff+judge row therefore
 * averages the diff F1 and the judge score, which is exactly the intended
 * composition.
 */
export function rollUpRow(caseId: string, fields: FieldResult[]): RowResult {
  const scoreable = fields.filter((f) => isScoreableState(f.state) && f.score !== null)
  const score =
    scoreable.length === 0
      ? null
      : scoreable.reduce((sum, f) => sum + (f.score as number), 0) / scoreable.length

  let state: FieldResultState
  if (fields.some((f) => f.state === 'rate-limited')) {
    state = 'rate-limited'
  } else if (fields.some((f) => f.state === 'judge-errored')) {
    state = 'judge-errored'
  } else if (scoreable.length === 0) {
    state = 'skipped'
  } else if (scoreable.every((f) => f.state === 'matched')) {
    state = 'matched'
  } else {
    state = 'mismatched'
  }

  return { caseId, fields, score, state, excluded: !isScoreableState(state) }
}

/**
 * Convenience: classify a set of raw field outcomes against the threshold config
 * and roll them up in one call. `fields` is graded in the given order.
 */
export function scoreRow(
  caseId: string,
  outcomes: FieldScoreOutcome[],
  thresholds: Thresholds,
): RowResult {
  const classified = outcomes.map((o) => classifyField(o, scorerThreshold(o.scorer, thresholds)))
  return rollUpRow(caseId, classified)
}

/** Distinct scorers that contributed to a row, in first-seen order. */
export function rowScorers(fields: FieldResult[]): ScorerName[] {
  const seen = new Set<ScorerName>()
  for (const f of fields) seen.add(f.scorer)
  return [...seen]
}

/** Distinct expected fields covered by a row, in first-seen order. */
export function rowFields(fields: FieldResult[]): ExpectedField[] {
  const seen = new Set<ExpectedField>()
  for (const f of fields) seen.add(f.field)
  return [...seen]
}
