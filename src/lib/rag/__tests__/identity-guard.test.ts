import { describe, it, expect } from 'vitest'
import type { Client } from 'pg'
import { checkEmbedderIdentity } from '../index'
import { MODEL, DIM } from '../../voyage'

function mockClient(meta: Record<string, string>): Client {
  return {
    query: (_sql: string, params: [string]) => {
      const key = params[0]
      const value = meta[key] ?? null
      return Promise.resolve({ rows: value !== null ? [{ value }] : [] })
    },
  } as unknown as Client
}

describe('checkEmbedderIdentity()', () => {
  it('passes when seed_meta matches runtime embedder', async () => {
    const client = mockClient({ embedder: MODEL, dimension: String(DIM) })
    await expect(checkEmbedderIdentity(client)).resolves.not.toThrow()
  })

  it('throws on embedder name mismatch', async () => {
    const client = mockClient({ embedder: 'voyage-2', dimension: String(DIM) })
    await expect(checkEmbedderIdentity(client)).rejects.toThrow(
      'Embedder mismatch'
    )
    await expect(checkEmbedderIdentity(client)).rejects.toThrow('voyage-2')
    await expect(checkEmbedderIdentity(client)).rejects.toThrow(MODEL)
  })

  it('throws on dimension mismatch', async () => {
    const client = mockClient({ embedder: MODEL, dimension: '512' })
    await expect(checkEmbedderIdentity(client)).rejects.toThrow(
      'Dimension mismatch'
    )
    await expect(checkEmbedderIdentity(client)).rejects.toThrow('512')
    await expect(checkEmbedderIdentity(client)).rejects.toThrow(String(DIM))
  })

  it('throws on missing embedder in seed_meta', async () => {
    const client = mockClient({ dimension: String(DIM) })
    await expect(checkEmbedderIdentity(client)).rejects.toThrow(
      'Embedder mismatch'
    )
  })

  it('throws on missing dimension in seed_meta', async () => {
    const client = mockClient({ embedder: MODEL })
    await expect(checkEmbedderIdentity(client)).rejects.toThrow(
      'Dimension mismatch'
    )
  })
})
