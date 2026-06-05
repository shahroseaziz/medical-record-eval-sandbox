/**
 * Regression tests for /api/retrieve (SHA-36).
 *
 * Covers:
 *   1. Missing VOYAGE_API_KEY returns 422 (not 503) — permanent config error,
 *      clients should not retry.
 *   2. Voyage embedding spend is metered through the killswitch (bookSpend called
 *      with VOYAGE_ESTIMATE_MICRO=10).
 *   3. SpendCapError from killswitch → 429.
 *   4. Upstash unreachable in killswitch → 503 (fail closed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockRlLimit = vi.fn().mockResolvedValue({
  success: true,
  limit: 10,
  remaining: 9,
  reset: Date.now() + 3_600_000,
})

vi.mock('@upstash/ratelimit', () => {
  const MockRatelimit = Object.assign(
    vi.fn().mockImplementation(() => ({ limit: mockRlLimit })),
    { slidingWindow: vi.fn().mockReturnValue({}) },
  )
  return { Ratelimit: MockRatelimit }
})

const mockIncrby = vi.fn().mockResolvedValue(100)
const mockDecrby = vi.fn().mockResolvedValue(0)
const mockExpire = vi.fn().mockResolvedValue(1)
const mockFromEnv = vi.fn(() => ({ incrby: mockIncrby, decrby: mockDecrby, expire: mockExpire }))

vi.mock('@upstash/redis', () => ({
  Redis: { fromEnv: mockFromEnv },
}))

vi.mock('@/lib/rag/index', () => ({
  retrieve: vi.fn().mockResolvedValue({
    chunks: [{ section: 'medications', text: 'Lisinopril 10mg daily.', distance: 0.1, similarity: 0.9 }],
    sql: 'SELECT ...',
    summary: 'retrieved 1 of 5 sections',
  }),
}))

vi.mock('@/lib/voyage', () => ({
  MODEL: 'voyage-3.5',
  DIM: 1024,
  embed: vi.fn().mockResolvedValue([[...Array(1024).fill(0.1)]]),
}))

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeReq(body: object): NextRequest {
  return new NextRequest('http://localhost/api/retrieve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/retrieve', () => {
  let savedVoyageKey: string | undefined

  beforeEach(() => {
    savedVoyageKey = process.env.VOYAGE_API_KEY
    process.env.VOYAGE_API_KEY = 'test-voyage-key'
    process.env.UPSTASH_REDIS_REST_URL = 'http://fake-upstash'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token'
    vi.clearAllMocks()
    mockIncrby.mockResolvedValue(100)    // default: well under cap
    mockFromEnv.mockReturnValue({ incrby: mockIncrby, decrby: mockDecrby, expire: mockExpire })
  })

  afterEach(() => {
    if (savedVoyageKey === undefined) {
      delete process.env.VOYAGE_API_KEY
    } else {
      process.env.VOYAGE_API_KEY = savedVoyageKey
    }
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
  })

  it('[RETRIEVE-422] returns 422 (not 503) when VOYAGE_API_KEY is not configured', async () => {
    delete process.env.VOYAGE_API_KEY

    const { POST } = await import('@/app/api/retrieve/route')
    const res = await POST(makeReq({ patientId: 'p1', query: 'what medications?' }))

    // 422 Unprocessable Entity — permanent config problem, not transient unavailability.
    // Callers should not retry; the operator needs to configure VOYAGE_API_KEY.
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toMatch(/VOYAGE_API_KEY/i)
    // Verify it's NOT a 503 (the pre-fix status code)
    expect(res.status).not.toBe(503)
  })

  it('[RETRIEVE-METER] books Voyage spend (incrby called with VOYAGE_ESTIMATE_MICRO=10)', async () => {
    const { POST } = await import('@/app/api/retrieve/route')
    const res = await POST(makeReq({ patientId: 'p1', query: 'what medications?' }))

    expect(res.status).toBe(200)
    // bookSpend internally calls redis.incrby with the spend amount.
    // VOYAGE_ESTIMATE_MICRO = 10 µ$, called for both daily and hourly keys.
    expect(mockIncrby).toHaveBeenCalledWith(expect.any(String), 10)
  })

  it('[RETRIEVE-CAP] returns 429 when daily spend cap is exceeded', async () => {
    // Simulate cap exceeded: incrby returns a value above DAILY_CAP_MICRO_USD (5_000_000)
    mockIncrby.mockResolvedValue(5_000_001)

    const { POST } = await import('@/app/api/retrieve/route')
    const res = await POST(makeReq({ patientId: 'p1', query: 'what medications?' }))

    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toMatch(/limit/i)
  })

  it('[RETRIEVE-UPSTASH-DOWN] returns 503 when Upstash is unreachable', async () => {
    // Simulate Upstash DNS/TCP failure
    mockFromEnv.mockImplementationOnce(() => {
      throw new Error('Upstash connection refused')
    })

    const { POST } = await import('@/app/api/retrieve/route')
    const res = await POST(makeReq({ patientId: 'p1', query: 'what medications?' }))

    expect(res.status).toBe(503)
  })
})
