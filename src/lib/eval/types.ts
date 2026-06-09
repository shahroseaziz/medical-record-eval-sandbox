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
