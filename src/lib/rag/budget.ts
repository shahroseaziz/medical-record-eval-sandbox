// SHA-78 / arch S25: retrieve-mode context assembly bounds by token COUNT, not k
// alone. Extracted from rag/index.ts into a DEPENDENCY-FREE module (imports only
// the local token estimator — no `pg`, no Voyage) so the budget seam can be reused
// from client-bundled surfaces (the RAG bench Inspector) without dragging the
// database/embedding stack into the browser build. rag/index.ts re-exports these
// names, so existing server-side importers are unchanged.

import { estimateInputTokens } from '../tokens'

export interface RetrievedChunk {
  section: string
  text: string
  distance: number
  similarity: number
}

export interface BudgetedAssembly {
  /** The in-budget subset of chunks, in retrieval (relevance) order. */
  chunks: RetrievedChunk[]
  /** How many chunks retrieval returned (before budget trimming). */
  retrievedCount: number
  /** How many of those fit the input budget and were actually assembled. */
  inBudgetCount: number
}

// Chunks are appended in retrieval (relevance) order until the next chunk would
// push the assembled prompt past the input budget, then assembly stops — partial
// chunk sets are valid. `overheadTokens` is the cost of everything in the prompt
// that is NOT chunk text (system prompt, query, template scaffolding), so the
// per-chunk budget is what's left after that fixed overhead.
//
// `render` formats a candidate chunk list into the grounding string exactly as the
// caller will send it, so the budget reflects the real joined payload (separators
// included), not a sum of isolated chunk estimates.
export function fitChunksToBudget(
  chunks: RetrievedChunk[],
  budgetTokens: number,
  overheadTokens: number,
  render: (chunks: RetrievedChunk[]) => string,
): BudgetedAssembly {
  const fit: RetrievedChunk[] = []
  for (const chunk of chunks) {
    const candidate = [...fit, chunk]
    const groundingTokens = estimateInputTokens(render(candidate))
    if (overheadTokens + groundingTokens > budgetTokens) {
      break
    }
    fit.push(chunk)
  }
  return { chunks: fit, retrievedCount: chunks.length, inBudgetCount: fit.length }
}
