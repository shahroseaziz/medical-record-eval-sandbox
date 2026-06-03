import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { embed } from '../voyage'

describe('embed()', () => {
  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key'
  })

  afterEach(() => {
    delete process.env.VOYAGE_API_KEY
    vi.restoreAllMocks()
  })

  it('returns vectors on success', async () => {
    const fakeVec = new Array(1024).fill(0.5)
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: fakeVec }] }),
    }))

    const result = await embed(['hello'], 'document')
    expect(result).toHaveLength(1)
    expect(result[0]).toHaveLength(1024)
  })

  it('throws when returned vector length is not 1024', async () => {
    const badVec = new Array(512).fill(0.1)
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: badVec }] }),
    }))

    await expect(embed(['hello'], 'document')).rejects.toThrow(
      'Expected embedding dimension 1024, got 512'
    )
  })

  it('throws on non-OK Voyage API response', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    }))

    await expect(embed(['hello'], 'document')).rejects.toThrow('Voyage API error 401')
  })

  it('throws when VOYAGE_API_KEY is absent', async () => {
    delete process.env.VOYAGE_API_KEY
    await expect(embed(['hello'], 'document')).rejects.toThrow('VOYAGE_API_KEY')
  })

  it('passes input_type to Voyage', async () => {
    const fakeVec = new Array(1024).fill(0.1)
    let capturedBody: unknown
    vi.stubGlobal('fetch', async (_url: string, opts: RequestInit) => {
      capturedBody = JSON.parse(opts.body as string)
      return { ok: true, json: async () => ({ data: [{ embedding: fakeVec }] }) }
    })

    await embed(['q'], 'query')
    expect((capturedBody as { input_type: string }).input_type).toBe('query')
  })
})
