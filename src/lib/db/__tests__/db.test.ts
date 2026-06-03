import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { SCHEMA_SQL, withClient, applySchema, getSeedMeta, setSeedMeta } from '../index'

async function activeConnCount(client: Client): Promise<number> {
  const res = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database()`
  )
  return parseInt(res.rows[0].count, 10)
}

describe.skipIf(!process.env.DATABASE_URL)('DB integration', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    await applySchema(client)
    await client.query('TRUNCATE traces, seed_meta, chunks, patients CASCADE')
  })

  afterAll(async () => {
    await client.end()
  })

  it('SCHEMA_SQL contains expected DDL in order', () => {
    expect(typeof SCHEMA_SQL).toBe('string')
    expect(SCHEMA_SQL).toContain('CREATE EXTENSION IF NOT EXISTS vector')
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS patients')
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS chunks')
    expect(SCHEMA_SQL).toContain('embedding vector(1024)')
    expect(SCHEMA_SQL).toContain('CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw')
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS seed_meta')
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS traces')

    // Extension must come before tables (pgvector type must exist first)
    const extIdx = SCHEMA_SQL.indexOf('CREATE EXTENSION')
    const patientsIdx = SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS patients')
    expect(extIdx).toBeLessThan(patientsIdx)
  })

  it('insert patient + 1024-dim chunk, query back', async () => {
    await client.query(
      `INSERT INTO patients (id, name, summary) VALUES ($1, $2, $3)`,
      ['pt-1', 'Jane Doe', JSON.stringify({ dob: '1985-06-15', gender: 'F' })]
    )

    const embedding = `[${new Array(1024).fill(0.1).join(',')}]`
    await client.query(
      `INSERT INTO chunks (patient_id, section, ord, text, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)`,
      ['pt-1', 'Problems', 1, 'Hypertension, chronic', embedding]
    )

    const { rows: patients } = await client.query<{
      id: string
      name: string
      summary: { dob: string; gender: string }
    }>(`SELECT id, name, summary FROM patients WHERE id = $1`, ['pt-1'])
    expect(patients).toHaveLength(1)
    expect(patients[0].id).toBe('pt-1')
    expect(patients[0].name).toBe('Jane Doe')
    expect(patients[0].summary.dob).toBe('1985-06-15')

    const { rows: chunks } = await client.query<{
      section: string
      ord: number
      text: string
    }>(`SELECT section, ord, text FROM chunks WHERE patient_id = $1`, ['pt-1'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0].section).toBe('Problems')
    expect(chunks[0].ord).toBe(1)
    expect(chunks[0].text).toBe('Hypertension, chronic')
  })

  it('seed_meta round-trip: set, get, upsert, missing key', async () => {
    await setSeedMeta(client, 'embedder', 'voyage-3.5')
    expect(await getSeedMeta(client, 'embedder')).toBe('voyage-3.5')

    expect(await getSeedMeta(client, 'nonexistent-key')).toBeNull()

    await setSeedMeta(client, 'embedder', 'voyage-3.5-lite')
    expect(await getSeedMeta(client, 'embedder')).toBe('voyage-3.5-lite')
  })

  it('connection-leak: N concurrent withClient() calls complete with no leaked connections', async () => {
    const N = 20
    const baseline = await activeConnCount(client)

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withClient(async (c) => {
          const r = await c.query<{ n: string }>('SELECT $1::int AS n', [i])
          return parseInt(r.rows[0].n, 10)
        })
      )
    )

    expect(results).toHaveLength(N)
    expect(results.sort((a, b) => a - b)).toEqual([...Array(N).keys()])

    // Allow TCP teardown to propagate
    await new Promise((r) => setTimeout(r, 200))

    const after = await activeConnCount(client)
    console.log(`Connection leak test: baseline=${baseline}, after=${after} (N=${N} concurrent calls)`)

    // All per-request clients must be closed — count must return to within 1 of baseline
    expect(after).toBeLessThanOrEqual(baseline + 1)
  })
})
