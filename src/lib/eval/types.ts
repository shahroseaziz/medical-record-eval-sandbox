export type EvalMode = 'retrieve' | 'stuff'

export interface RetrievedChunkInput {
  section: string
  text: string
}

/** Identifiers for the scorers shipped in this lib. */
export type ScorerName =
  | 'contains'
  | 'faithfulness'
  | 'extraction-completeness'
  | 'section-hit'
  | 'structured-diff'
  | 'reference-judge'

/**
 * Canonical hand-authored expected-output fields a scorer can target.
 *  - 'structured': the expected structured output (field→value object)
 *  - 'prose':      the expected free-text prose, authored from the patient
 *                  summary. Deliberately NOT named `summary` to avoid colliding
 *                  with the `patients.summary` jsonb column read by /api/patients.
 */
export type ExpectedField = 'structured' | 'prose'

/** Maps each expected-output field to the scorer that grades it. */
export type FieldScorerMap = Partial<Record<ExpectedField, ScorerName>>

export interface EvalCase {
  id: string
  patientId: string
  /** The query given to the model (never used as grounding) */
  query: string
  /** The model's output to score */
  output: string
  mode: EvalMode
  /** Retrieve mode: chunks returned by RAG */
  retrievedChunks?: RetrievedChunkInput[]
  /** Retrieve mode: number of chunks requested */
  k?: number
  /** Stuff mode: the full record text */
  record?: string
  /** Expected output string (for contains scorer) */
  expectedOutput?: string
  /** Expected claim list (for extraction-completeness scorer) */
  expectedClaims?: string[]
  /** Required section names (for section-hit scorer, retrieve mode only) */
  requiredSections?: string[]
  /** Hand-authored expected structured output (field→value), graded per fieldScorers */
  expectedStructured?: Record<string, unknown>
  /** Hand-authored expected prose, authored from the patient summary (distinct from patients.summary) */
  expectedProse?: string
  /** Maps each expected-output field to the scorer that grades it */
  fieldScorers?: FieldScorerMap
}

export interface BaseScoreResult {
  scorer: string
  score: number | null
  errored?: boolean
  errorMessage?: string
}

export interface ContainsResult extends BaseScoreResult {
  scorer: 'contains'
  score: 0 | 1 | null
  normalizedOutput: string
  expectedItems: string[]
  missingItems: string[]
}

export interface FaithfulnessClaim {
  claim: string
  verdict: 'supported' | 'unsupported' | 'partial'
  rationale: string
}

export interface FaithfulnessResult extends BaseScoreResult {
  scorer: 'faithfulness'
  claims: FaithfulnessClaim[]
  /** True when 0 claims extracted — score is 1.0 but excluded from aggregates */
  zeroClaimFlag?: boolean
  /** Prompt sent to Claude for claim extraction (call 1) */
  extractPrompt: string
  /** Prompt sent to Claude for claim verdicting (call 2); rubric text is redacted when caller-supplied */
  verdictPrompt: string
  /** Present when a caller-supplied verdict rubric was used; sha256=<hex8> len=<n> (rubric text is never persisted) */
  verdictRubricMeta?: string
}

/** Meaning-equivalence verdicts returned by the reference judge. */
export type ReferenceVerdict = 'equivalent' | 'partial' | 'divergent'

export interface ReferenceJudgeResult extends BaseScoreResult {
  scorer: 'reference-judge'
  /** 1.0 / 0.5 / 0.0 for equivalent / partial / divergent; null when the judge errored */
  score: number | null
  /** null when the judge errored (never a fabricated verdict) */
  verdict: ReferenceVerdict | null
  /** null when the judge errored */
  reason: string | null
  /** Redacted prompt safe to persist: EXPECTED/ACTUAL/criteria replaced with sha256+len markers */
  judgePrompt: string
  /** Present when caller-supplied criteria was used; sha256=<hex8> len=<n> (criteria text is never persisted) */
  criteriaMeta?: string
}

export interface ExtractionCompletenessResult extends BaseScoreResult {
  scorer: 'extraction-completeness'
  expectedCount: number
  actualCount: number
  underExtractionFlagged: boolean
}

export interface SectionHitResult extends BaseScoreResult {
  scorer: 'section-hit'
  /** null in stuff mode */
  score: 0 | 1 | null
  requiredSections: string[]
  retrievedSections: string[]
  missingSections: string[]
}

/**
 * One per-field outcome in a structured diff.
 *  - 'match':    expected & actual values agree (after normalization)  → true positive
 *  - 'mismatch': both sides present but disagree                       → false pos + false neg
 *  - 'missing':  expected the field/item, actual omitted it            → false negative
 *  - 'extra':    actual produced a field/item not in expected          → false positive
 */
export interface StructuredFieldDiff {
  /** Canonical item key (normalized drug name) the field belongs to. */
  item: string
  /** Which field of the item is being compared. */
  field: 'name' | 'dose'
  status: 'match' | 'mismatch' | 'missing' | 'extra'
  /** Expected value as authored (undefined when expected omitted it). */
  expected?: string
  /** Actual value as produced (undefined when actual omitted it). */
  actual?: string
}

export interface StructuredDiffResult extends BaseScoreResult {
  scorer: 'structured-diff'
  /** F1 over field-level matches; null when there is nothing to compare. */
  score: number | null
  /** Every per-field comparison, in expected-then-extra order. */
  fields: StructuredFieldDiff[]
  /** Confusion-matrix counts over field-level diffs. */
  matchCount: number
  mismatchCount: number
  /** False negatives: expected fields missing from actual. */
  missingCount: number
  /** False positives: actual fields not in expected. */
  extraCount: number
  precision: number
  recall: number
  /**
   * Normalization limitations encountered on THIS case (unparseable doses,
   * multi-strength duplicate names, un-converted compound/concentration units,
   * and salt strips that altered a name and could mask a distinct salt).
   * Surfaced so the blind spots are visible, never hidden behind a clean-looking
   * score. Deduped.
   */
  blindSpots: string[]
}
