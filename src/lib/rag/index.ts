import type { Client } from 'pg'
import { withClient, getSeedMeta } from '../db/index'
import { embed, MODEL, DIM } from '../voyage'

// The budget seam lives in a dependency-free module so client-bundled surfaces
// can reuse it without pulling `pg`/Voyage. Re-exported here so server-side
// importers (the run route, the assembly-budget tests) keep their import path.
export { fitChunksToBudget } from './budget'
export type { RetrievedChunk, BudgetedAssembly } from './budget'

import type { RetrievedChunk } from './budget'

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
