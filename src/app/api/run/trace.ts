// ── RunTrace assembly — the single trace-construction surface ─────────────────
//
// Extracted from the /api/run route so the persistence path is a PURE, testable
// function (rule 13 — trace logging is designed-in, not retrofit). The route
// computes the model-side values (output, usage, grounding); this projects them
// into the persisted `RunTrace`. Pulling it out lets the E25 firewall test grep
// the REAL trace assembly — not a hand-built projection — so an answer-key leak
// introduced here would be caught by test, not merely by convention.

import type { RetrievedChunk } from '@/lib/rag/index'
import type { FaithfulnessResult, SectionHitResult } from '@/lib/eval/index'
import type { RunMode, RunTrace } from './types'

export interface TraceAssemblyInput {
  caseId: string
  mode: RunMode
  /** Assembled grounding context (chunk text in retrieve mode, raw record in stuff mode). */
  groundingContext: string
  /** True when the caller supplied a custom generation prompt (prompt text is then redacted). */
  isUserAuthored: boolean
  /** Assembled prompt as it should be persisted — already redacted when user-authored. */
  assembledPromptForTrace: string
  chunks: RetrievedChunk[]
  retrievedCount: number
  inBudgetCount: number
  sectionHit: SectionHitResult
  /** Null in generate-only mode (the judge call is skipped). */
  faithfulness: FaithfulnessResult | null
  output: string
  generationModel: string
  judgeModel: string
  embeddingModel: string
  tokens: {
    input: number
    output: number
    estCostUsd: number
    /** Prompt-cache read/write token counts from the provider (D8); 0 when absent. */
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  /** Whether the judge used the caller's BYO key (scores non-comparable to baseline). */
  judgeUsesByo: boolean
}

/**
 * Project the route's computed values into a persisted `RunTrace`. Only generation-
 * and scoring-derived values are copied; there is no path for answer-key fields
 * (`expectedProse` / `expectedStructured` / `fieldScorers`) to enter a trace — they
 * are not part of this input shape at all (E25 firewall extension).
 */
export function assembleRunTrace(i: TraceAssemblyInput): RunTrace {
  return {
    caseId: i.caseId,
    ragMode: i.mode,
    grounding: i.groundingContext,
    generationPromptIsUserAuthored: i.isUserAuthored,
    retrieval:
      i.mode === 'retrieve'
        ? {
            chunks: i.chunks.map((c) => ({
              section: c.section,
              text: c.text,
              distance: c.distance,
              similarity: c.similarity,
            })),
            groundingContext: i.groundingContext,
            assembledPrompt: i.assembledPromptForTrace,
            retrievedCount: i.retrievedCount,
            inBudgetCount: i.inBudgetCount,
          }
        : undefined,
    sectionHit: i.sectionHit,
    output: i.output,
    scorerResults: i.faithfulness ? [i.faithfulness, i.sectionHit] : [i.sectionHit],
    generationModel: i.generationModel,
    judgeModel: i.judgeModel,
    embeddingModel: i.embeddingModel,
    inputType: 'query',
    tokens: i.tokens,
    claimCount: i.faithfulness ? i.faithfulness.claims.length : 0,
    outputLength: i.output.length,
    judgeUsesByo: i.judgeUsesByo,
  }
}
