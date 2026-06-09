import type { SectionHitResult, FaithfulnessResult } from '@/lib/eval/index'

export type RunMode = 'retrieve' | 'stuff'

export interface RunTrace {
  caseId: string
  ragMode: RunMode
  /** Assembled grounding context used for generation (chunk text in retrieve mode, raw record in stuff mode). */
  grounding: string
  /** True when the generation prompt was caller-supplied; the prompt text is then redacted from all trace fields. */
  generationPromptIsUserAuthored: boolean
  retrieval?: {
    chunks: Array<{ section: string; text: string; distance: number; similarity: number }>
    groundingContext: string
    /** Full assembled prompt, or a "[REDACTED sha256=… length=…]" marker when the caller supplied a custom prompt. */
    assembledPrompt: string
  }
  sectionHit: SectionHitResult
  output: string
  scorerResults: Array<FaithfulnessResult | SectionHitResult>
  generationModel: string
  judgeModel: string
  embeddingModel: string
  inputType: 'query'
  tokens: {
    input: number
    output: number
    estCostUsd: number
  }
  claimCount: number
  outputLength: number
  /** Whether the judge used the caller's BYO key. When true, scores are non-comparable to seeded baseline. */
  judgeUsesByo: boolean
}

export interface RunRequest {
  patientId: string
  query: string
  mode: RunMode
  /** Full record text — required for stuff mode */
  record?: string
  /** Number of chunks to retrieve — retrieve mode only, default 6 */
  k?: number
  /** Generation model; defaults to claude-haiku-4-5-20251001 */
  model?: string
  /** Judge model for faithfulness scoring; defaults to claude-haiku-4-5-20251001 */
  judgeModel?: string
  /** If true, the judge uses the caller's BYO key instead of the seeded key. Default: false. */
  judgeUsesByo?: boolean
  /**
   * Generate-only mode: stream the generation (and retrieval metadata) but skip the
   * faithfulness judge call and the `eval` data part. Used by the live-generation
   * fan-out that re-runs a prompt across N cases — scoring happens separately so the
   * expensive judge isn't paid N times during iteration. Section-hit (deterministic,
   * no model call) is still computed and persisted to the trace. Default: false.
   */
  generateOnly?: boolean
  /**
   * Caller-supplied system/generation prompt. When provided it replaces the built-in
   * medical-record-analyst template. The text is NEVER persisted — traces store only
   * a sha256 hash + length when this field is set.
   */
  generationPrompt?: string
}
