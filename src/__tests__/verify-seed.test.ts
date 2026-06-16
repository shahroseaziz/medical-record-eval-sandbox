import { describe, it, expect } from 'vitest'
import type { Client } from 'pg'
import { verifySeed } from '../../scripts/verify-seed'

interface SeedState {
  meta: Record<string, string | undefined>
  patientCount: number
  chunkCount: number
  chunksWithXml: number
}

// A mock pg Client that answers the exact queries verifySeed issues, driven by a
// declarative seed state. Lets us exercise every invariant without a live DB.
function mockClient(state: SeedState): Client {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: async (sql: string, params?: any[]) => {
      if (/FROM seed_meta WHERE key/.test(sql)) {
        const key = params?.[0] as string
        const value = state.meta[key]
        return { rows: value === undefined ? [] : [{ value }] }
      }
      if (/count\(\*\).*FROM patients/.test(sql)) {
        return { rows: [{ n: String(state.patientCount) }] }
      }
      if (/FROM chunks WHERE source_xml IS NOT NULL/.test(sql)) {
        return { rows: [{ n: String(state.chunksWithXml) }] }
      }
      if (/count\(\*\).*FROM chunks/.test(sql)) {
        return { rows: [{ n: String(state.chunkCount) }] }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  } as unknown as Client
}

function goodState(): SeedState {
  return {
    meta: { patient_count: '3', chunk_count: '48', embedder: 'voyage-3.5', dimension: '1024' },
    patientCount: 3,
    chunkCount: 48,
    chunksWithXml: 48,
  }
}

describe('verifySeed()', () => {
  it('passes a clean single-seed DB (exact counts, identity, full coverage)', async () => {
    const v = await verifySeed(mockClient(goodState()))
    expect(v.patientCount).toBe(3)
    expect(v.chunkCount).toBe(48)
    expect(v.sourceXmlCoverage).toBe(1)
  })

  it('catches a duplicate re-seed: doubled chunks trip the exact-count check', async () => {
    const s = goodState()
    s.chunkCount = 96 // re-seed doubled rows; seed_meta.chunk_count still 48
    s.chunksWithXml = 96
    await expect(verifySeed(mockClient(s))).rejects.toThrow(/Chunk count mismatch/)
    await expect(verifySeed(mockClient(s))).rejects.toThrow(/exactly double/i)
  })

  it('rejects a patient-count mismatch (not a >0 check)', async () => {
    const s = goodState()
    s.patientCount = 2
    await expect(verifySeed(mockClient(s))).rejects.toThrow(/Patient count mismatch/)
  })

  it('rejects when source_xml coverage is below 95%', async () => {
    const s = goodState()
    s.chunksWithXml = 40 // 40/48 ≈ 83%
    await expect(verifySeed(mockClient(s))).rejects.toThrow(/source_xml coverage/)
  })

  it('accepts coverage at or just above the 95% floor', async () => {
    const s = goodState()
    s.chunkCount = 100
    s.patientCount = 3
    s.chunksWithXml = 96 // 96%
    s.meta.chunk_count = '100'
    const v = await verifySeed(mockClient(s))
    expect(v.sourceXmlCoverage).toBeGreaterThanOrEqual(0.95)
  })

  it('rejects an embedder identity mismatch (reuses checkEmbedderIdentity)', async () => {
    const s = goodState()
    s.meta.embedder = 'voyage-2'
    await expect(verifySeed(mockClient(s))).rejects.toThrow(/Embedder mismatch/)
  })

  it('errors clearly when the count baselines are missing (pre-v3 seed)', async () => {
    const s = goodState()
    s.meta.chunk_count = undefined
    await expect(verifySeed(mockClient(s))).rejects.toThrow(/missing "chunk_count"/)
  })
})
