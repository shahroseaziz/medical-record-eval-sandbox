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
}
