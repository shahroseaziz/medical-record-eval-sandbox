import type { Client } from 'pg'
import { withClient, getSeedMeta } from '../db/index'
import { embed, MODEL, DIM } from '../voyage'
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

// SHA-78 / arch S25: retrieve-mode context assembly bounds by token COUNT, not k
// alone. Chunks are appended in retrieval (relevance) order until the next chunk
// would push the assembled prompt past the input budget, then assembly stops —
// partial chunk sets are valid. `overheadTokens` is the cost of everything in the
// prompt that is NOT chunk text (system prompt, query, template scaffolding), so
// the per-chunk budget is what's left after that fixed overhead.
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

export interface RetrieveResult {
  chunks: RetrievedChunk[]
  sql: string
  summary: string
}

const RETRIEVE_SQL =
  'SELECT section, text, (embedding <=> $2::vector) AS distance, ' +
  '1 - (embedding <=> $2::vector) AS similarity ' +
  'FROM chunks WHERE patient_id = $1 ' +
  'ORDER BY embedding <=> $2::vector LIMIT $3'

export async function checkEmbedderIdentity(client: Client): Promise<void> {
  const storedModel = await getSeedMeta(client, 'embedder')
  const storedDim = await getSeedMeta(client, 'dimension')

  if (storedModel !== MODEL) {
    throw new Error(
      `Embedder mismatch: index was built with "${storedModel}" but runtime uses "${MODEL}". ` +
        `Re-run ingest with the current embedder before querying.`
    )
  }
  if (storedDim !== String(DIM)) {
    throw new Error(
      `Dimension mismatch: index was built with dim=${storedDim} but runtime uses dim=${DIM}. ` +
        `Re-run ingest with the current embedder before querying.`
    )
  }
}

export async function retrieve(
  patientId: string,
  query: string,
  k = 6
): Promise<RetrieveResult> {
  return withClient(async (client) => {
    await checkEmbedderIdentity(client)

    const [queryVec] = await embed([query], 'query')
    const vecStr = `[${queryVec.join(',')}]`

    const totalRes = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM chunks WHERE patient_id = $1',
      [patientId]
    )
    const total = parseInt(totalRes.rows[0].count, 10)

    const result = await client.query<{
      section: string
      text: string
      distance: string
      similarity: string
    }>(RETRIEVE_SQL, [patientId, vecStr, k])

    const chunks: RetrievedChunk[] = result.rows.map((r) => ({
      section: r.section,
      text: r.text,
      distance: Number(r.distance),
      similarity: Number(r.similarity),
    }))

    const summary = `retrieved ${chunks.length} of ${total} sections`

    return { chunks, sql: RETRIEVE_SQL, summary }
  })
}
