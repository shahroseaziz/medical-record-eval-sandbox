import type { SectionHitResult, FaithfulnessResult } from '@/lib/eval/index'

export type RunMode = 'retrieve' | 'stuff'

export interface RunTrace {
  caseId: string
  ragMode: RunMode
  retrieval?: {
    chunks: Array<{ section: string; text: string; distance: number; similarity: number }>
    groundingContext: string
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
}

export interface RunRequest {
  patientId: string
  query: string
  mode: RunMode
  /** Full record text — required for stuff mode */
  record?: string
  /** Number of chunks to retrieve — retrieve mode only, default 6 */
  k?: number
  /** BYO Anthropic API key; falls back to ANTHROPIC_API_KEY env var */
  apiKey?: string
  /** Generation model; defaults to claude-haiku-4-5-20251001 */
  model?: string
  /** Judge model for faithfulness scoring; defaults to claude-haiku-4-5-20251001 */
  judgeModel?: string
}
