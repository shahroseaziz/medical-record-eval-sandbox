import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { checkNotPopulated, parseSeedSql, executeSeedSql, loadSeedSql } from '../../scripts/seed'
import type { Client } from 'pg'

const FIXTURE_SQL = readFileSync(
  join(process.cwd(), 'src/__tests__/fixtures/seed-fixture.sql'),
  'utf-8'
)

function mockClient(queryFn: (sql: string) => Promise<{ rows: unknown[] }>): Client {
  return { query: vi.fn(queryFn) } as unknown as Client
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── checkNotPopulated ──────────────────────────────────────────────────────

describe('checkNotPopulated()', () => {
  it('allows seed when patients table does not exist', async () => {
    const client = mockClient(async () => ({ rows: [{ exists: false }] }))
    await expect(checkNotPopulated(client)).resolves.not.toThrow()
  })

  it('allows seed when patients table exists but is empty', async () => {
    let call = 0
    const client = mockClient(async () => {
      call++
      if (call === 1) return { rows: [{ exists: true }] }
      return { rows: [{ has_rows: false }] }
    })
    await expect(checkNotPopulated(client)).resolves.not.toThrow()
  })

  it('rejects seed when patients table already has rows', async () => {
    let call = 0
    const client = mockClient(async () => {
      call++
      if (call === 1) return { rows: [{ exists: true }] }
      return { rows: [{ has_rows: true }] }
    })
    await expect(checkNotPopulated(client)).rejects.toThrow(
      'Database already contains patient data'
    )
  })
})

// ── parseSeedSql ───────────────────────────────────────────────────────────

describe('parseSeedSql()', () => {
  it('extracts DDL and COPY blocks from fixture', () => {
    const { ddl, copyBlocks } = parseSeedSql(FIXTURE_SQL)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS patients')
    expect(copyBlocks).toHaveLength(1)
    expect(copyBlocks[0].table).toBe('seed_meta')
    expect(copyBlocks[0].columns).toEqual(['key', 'value'])
    expect(copyBlocks[0].rows).toHaveLength(3)
    expect(copyBlocks[0].rows[0]).toEqual(['embedder', 'voyage-3.5'])
  })

  it('unescapes tab and newline in COPY data', () => {
    const sql = `COPY seed_meta (key, value) FROM STDIN;\nk\\there\\ttoo\tv\\nalue\n\\.`
    const { copyBlocks } = parseSeedSql(sql)
    expect(copyBlocks[0].rows[0][0]).toBe('k\there\ttoo')
    expect(copyBlocks[0].rows[0][1]).toBe('v\nalue')
  })
})

// ── executeSeedSql ─────────────────────────────────────────────────────────

describe('executeSeedSql()', () => {
  it('executes DDL and INSERTs for each COPY row', async () => {
    const calls: string[] = []
    const client = mockClient(async (sql) => {
      calls.push(sql.trimStart().split('\n')[0])
      return { rows: [] }
    })
    await executeSeedSql(client, FIXTURE_SQL)
    // First call is the DDL block; the COPY-row INSERTs are wrapped in a
    // single BEGIN/COMMIT transaction so a partial seed can't leave the DB
    // half-populated.
    expect(calls.length).toBeGreaterThanOrEqual(2) // DDL + inserts
    expect(calls[0]).toContain('CREATE')
    const inserts = calls.filter((s) => s.startsWith('INSERT INTO'))
    expect(inserts).toHaveLength(3) // one per seed_meta COPY row
    expect(inserts.every((s) => s.startsWith('INSERT INTO seed_meta'))).toBe(true)
    expect(calls).toContain('BEGIN')
    expect(calls).toContain('COMMIT')
  })

  it('is fail-fast: stops on first SQL error', async () => {
    let callCount = 0
    const client = mockClient(async () => {
      callCount++
      if (callCount >= 2) throw new Error('unique constraint violation')
      return { rows: [] }
    })

    await expect(executeSeedSql(client, FIXTURE_SQL)).rejects.toThrow('unique constraint')
    // DDL (call 1) passed, first INSERT (call 2) failed → no more calls
    expect(callCount).toBe(2)
  })
})

// ── loadSeedSql ────────────────────────────────────────────────────────────

describe('loadSeedSql()', () => {
  it('fetches, gunzips, and returns SQL string', async () => {
    const compressed = gzipSync(Buffer.from(FIXTURE_SQL))
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      arrayBuffer: async () =>
        compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength),
    }))

    const sql = await loadSeedSql('https://example.com/seed.sql.gz')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS patients')
  })

  it('throws on non-OK fetch response', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, statusText: 'Not Found' }))
    await expect(loadSeedSql('https://example.com/seed.sql.gz')).rejects.toThrow(
      'Failed to fetch seed asset: 404'
    )
  })
})
