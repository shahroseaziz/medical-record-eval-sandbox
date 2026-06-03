import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withClient, applySchema, setSeedMeta } from '../lib/db/index'
import { embed } from '../lib/voyage'
import { parseCcda } from '../lib/ccda/index'
import { retrieve } from '../lib/rag/index'

const FIXTURE = join(
  process.cwd(),
  'src/lib/ccda/__fixtures__/Agustin437_Hills818_e0de7b0a-c40b-6467-c099-0f9467be6c0a.xml'
)
const BATCH_SIZE = 16

const hasEnv = !!(process.env.DATABASE_URL && process.env.VOYAGE_API_KEY)

describe.skipIf(!hasEnv)('RAG integration (live Voyage + pgvector)', () => {
  let seededPatientId: string
  let totalChunkCount: number

  beforeAll(async () => {
    const xml = readFileSync(FIXTURE, 'utf-8')
    const { patientId, demographics, chunks: rawChunks, summary } = parseCcda(xml)
    seededPatientId = patientId

    await withClient(async (client) => {
      await applySchema(client)
      await client.query('TRUNCATE traces, seed_meta, chunks, patients CASCADE')

      await setSeedMeta(client, 'embedder', 'voyage-3.5')
      await setSeedMeta(client, 'dimension', '1024')
      await setSeedMeta(client, 'input_type', 'document')

      const name = [demographics.firstName, demographics.lastName].filter(Boolean).join(' ')
      await client.query(
        `INSERT INTO patients (id, name, summary) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, summary = EXCLUDED.summary`,
        [patientId, name, JSON.stringify(summary)]
      )

      const texts = rawChunks.map((c) => c.text)
      const embeddings: number[][] = []
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const vecs = await embed(texts.slice(i, i + BATCH_SIZE), 'document')
        embeddings.push(...vecs)
      }

      for (let i = 0; i < rawChunks.length; i++) {
        const c = rawChunks[i]
        const vec = `[${embeddings[i].join(',')}]`
        await client.query(
          `INSERT INTO chunks (patient_id, section, ord, text, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [patientId, c.section, c.ord, c.text, vec]
        )
      }

      totalChunkCount = rawChunks.length
    })
  }, 180_000)

  it('returns ranked chunks with distance and similarity for both metrics', async () => {
    const result = await retrieve(seededPatientId, 'diabetes medications and treatment', 6)

    expect(result.chunks.length).toBeGreaterThan(0)
    expect(result.chunks.length).toBeLessThanOrEqual(6)

    for (const chunk of result.chunks) {
      expect(chunk.section).toBeTruthy()
      expect(chunk.text).toBeTruthy()
      expect(typeof chunk.distance).toBe('number')
      expect(typeof chunk.similarity).toBe('number')
      expect(chunk.distance).toBeGreaterThanOrEqual(0)
      expect(chunk.similarity).toBeGreaterThanOrEqual(0)
      expect(chunk.similarity).toBeLessThanOrEqual(1)
      expect(chunk.distance + chunk.similarity).toBeCloseTo(1, 5)
    }

    // Chunks must be sorted by ascending distance (closest first)
    for (let i = 1; i < result.chunks.length; i++) {
      expect(result.chunks[i].distance).toBeGreaterThanOrEqual(result.chunks[i - 1].distance)
    }

    // The most relevant chunk should be noticeably closer than a random chunk
    expect(result.chunks[0].similarity).toBeGreaterThan(0.3)
  }, 30_000)

  it('summary string reports "retrieved X of Y sections"', async () => {
    const result = await retrieve(seededPatientId, 'patient history', 6)

    expect(result.summary).toMatch(/^retrieved \d+ of \d+ sections$/)

    const [, retrieved, , total] = result.summary.split(' ')
    expect(parseInt(retrieved)).toBeGreaterThan(0)
    expect(parseInt(total)).toBe(totalChunkCount)
    expect(parseInt(retrieved)).toBeLessThanOrEqual(parseInt(total))
  }, 30_000)

  it('exposes the executed SQL string', async () => {
    const result = await retrieve(seededPatientId, 'medications', 3)

    expect(result.sql).toContain('embedding <=> ')
    expect(result.sql).toContain('ORDER BY')
    expect(result.sql).toContain('LIMIT')
    expect(result.sql).toContain('patient_id')
  }, 30_000)

  it('identity guard rejects a simulated embedder mismatch', async () => {
    await withClient(async (client) => {
      await client.query(`UPDATE seed_meta SET value = 'voyage-999' WHERE key = 'embedder'`)
    })

    await expect(retrieve(seededPatientId, 'test query')).rejects.toThrow(
      'Embedder mismatch'
    )

    // restore so subsequent tests pass
    await withClient(async (client) => {
      await client.query(`UPDATE seed_meta SET value = 'voyage-3.5' WHERE key = 'embedder'`)
    })
  }, 30_000)
})
