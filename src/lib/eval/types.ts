export type EvalMode = 'retrieve' | 'stuff'

export interface RetrievedChunkInput {
  section: string
  text: string
}

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
  /** Prompt sent to Claude for claim verdicting (call 2) */
  verdictPrompt: string
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
