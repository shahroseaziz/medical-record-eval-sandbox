/**
 * Integration tests for /api/score.
 *
 * Covers:
 *   1. captured-grounding scoring (happy path)
 *   2. refetch-fallback stamped with groundingNote
 *   3. refund booked on error
 *   4. a score POST decrements the SAME per-IP allowance as /api/run
 *   5. malformed rubric → judge-errored response (not a crash, not a fake score)
 *   6. validation errors for missing/bad fields
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ── Mock setup ────────────────────────────────────────────────────────────────

const mockIncrby = vi.fn().mockResolvedValue(100)
const mockDecrby = vi.fn().mockResolvedValue(0)
const mockExpire = vi.fn().mockResolvedValue(1)

vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: vi.fn(() => ({
      incrby: mockIncrby,
      decrby: mockDecrby,
      expire: mockExpire,
    })),
  },
}))

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

// Mock Voyage embed so retrieve() doesn't need a real API key
vi.mock('../lib/voyage', () => ({
  MODEL: 'voyage-3.5',
  DIM: 1024,
  embed: vi.fn().mockResolvedValue([[...Array(1024).fill(0.1)]]),
}))

// Mock lib/rag retrieve so we control the returned chunks
vi.mock('../lib/rag/index', () => ({
  retrieve: vi.fn().mockResolvedValue({
    chunks: [
      { section: 'medications', text: 'Patient takes Lisinopril 10mg daily.', distance: 0.1, similarity: 0.9 },
    ],
    sql: 'SELECT ...',
    summary: 'retrieved 1 of 5 sections',
  }),
}))

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate }
    },
  }
})

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeReq(body: object, extraHeaders: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
}

/** Stable extract → verdict mock pair. */
function setupJudgeMocks() {
  mockCreate.mockReset()
  let callIdx = 0
  mockCreate.mockImplementation(() => {
    const idx = callIdx++
    if (idx % 2 === 0) {
      return Promise.resolve({
        content: [{
          type: 'tool_use',
          name: 'extract_claims',
          input: { claims: ['Patient takes Lisinopril 10mg daily.'] },
        }],
      })
    }
    return Promise.resolve({
      content: [{
        type: 'tool_use',
        name: 'verdict_claims',
        input: {
          verdicts: [{
            claim: 'Patient takes Lisinopril 10mg daily.',
            verdict: 'supported',
            rationale: 'Explicitly stated in grounding.',
          }],
        },
      }],
    })
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/score integration (mocked Claude)', () => {
  let handler: typeof import('../app/api/score/route').POST

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.VOYAGE_API_KEY = 'test-voyage-key'
    const mod = await import('../app/api/score/route')
    handler = mod.POST
  })

  beforeEach(() => {
    setupJudgeMocks()
    mockIncrby.mockClear()
    mockDecrby.mockClear()
    mockIncrby.mockResolvedValue(100)
    mockDecrby.mockResolvedValue(0)
  })

  // ── 1. captured-grounding happy path ────────────────────────────────────────

  describe('captured-grounding scoring', () => {
    it('returns 200 with score and per-claim breakdown', async () => {
      const res = await handler(makeReq({
        source: 'captured',
        capturedOutput: 'Patient takes Lisinopril 10mg daily.',
        capturedGrounding: '[medications]\nPatient takes Lisinopril 10mg daily.',
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(typeof body.score).toBe('number')
      expect(Array.isArray(body.claims)).toBe(true)
      expect(body.groundingSource).toBe('captured')
      expect(body.groundingNote).toBeUndefined()

      const claims = body.claims as Array<Record<string, unknown>>
      expect(claims.length).toBeGreaterThan(0)
      expect(claims[0]).toHaveProperty('claim')
      expect(claims[0]).toHaveProperty('verdict')
      expect(claims[0]).toHaveProperty('reason')
    })

    it('accepts an optional userVerdictRubric and redacts it in verdictRubricMeta', async () => {
      const res = await handler(makeReq({
        source: 'captured',
        capturedOutput: 'Patient takes Lisinopril.',
        capturedGrounding: 'Patient takes Lisinopril 10mg daily.',
        userVerdictRubric: 'If the claim is partially hedged, mark it unsupported.',
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      // Rubric text must NOT appear in the response; only the redaction marker
      expect(typeof body.verdictRubricMeta).toBe('string')
      expect(body.verdictRubricMeta as string).toMatch(/\[judge-rubric redacted sha256=[0-9a-f]+ len=\d+\]/)
      // Raw rubric text must not leak
      expect(JSON.stringify(body)).not.toContain('If the claim is partially hedged')
    })
  })

  // ── 2. refetch-fallback stamped stale ───────────────────────────────────────

  describe('refetch-fallback', () => {
    it('stamps groundingNote when source is refetch (retrieve mode)', async () => {
      const res = await handler(makeReq({
        source: 'refetch',
        capturedOutput: 'Patient takes Lisinopril 10mg daily.',
        patientId: 'p1',
        ragMode: 'retrieve',
        query: 'What medications is the patient on?',
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.groundingSource).toBe('refetch')
      expect(body.groundingNote).toContain('re-fetched')
      expect(body.groundingNote).toContain('may differ from capture')
    })

    it('stamps groundingNote when source is refetch (stuff mode)', async () => {
      const res = await handler(makeReq({
        source: 'refetch',
        capturedOutput: 'Patient takes Lisinopril 10mg daily.',
        patientId: 'p1',
        ragMode: 'stuff',
        record: 'Patient takes Lisinopril 10mg daily.',
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.groundingSource).toBe('refetch')
      expect(typeof body.groundingNote).toBe('string')
    })
  })

  // ── 3. refund booked on error ────────────────────────────────────────────────

  describe('refund on error', () => {
    it('calls decrby (refund) when retrieve() throws mid-flight (outer error path)', async () => {
      // The scorer swallows judge failures internally and returns errored:true.
      // To test the outer try/catch refund path, make retrieve() throw so the
      // exception escapes the catch-free scoring block.
      const { retrieve: mockRetrieve } = await import('../lib/rag/index')
      vi.mocked(mockRetrieve).mockRejectedValueOnce(new Error('DB connection failed'))

      const res = await handler(makeReq({
        source: 'refetch',
        capturedOutput: 'Some output.',
        patientId: 'p1',
        ragMode: 'retrieve',
        query: 'What medications?',
      }) as never)

      // Outer catch returns 503 and fires the refund
      expect(res.status).toBe(503)
      expect(mockDecrby).toHaveBeenCalled()

      // Restore stable mock for subsequent tests
      vi.mocked(mockRetrieve).mockResolvedValue({
        chunks: [{ section: 'medications', text: 'Patient takes Lisinopril 10mg daily.', distance: 0.1, similarity: 0.9 }],
        sql: 'SELECT ...',
        summary: 'retrieved 1 of 5 sections',
      })
    })

    it('judge call failure returns errored:true (200) without calling refund — spend is consumed', async () => {
      // scoreFaithfulness swallows errors from the judge and returns errored:true.
      // The route returns 200 with errored:true; no refund fires for a failed judge call.
      mockCreate.mockReset()
      mockCreate.mockRejectedValue(new Error('Anthropic error'))

      const res = await handler(makeReq({
        source: 'captured',
        capturedOutput: 'Some output.',
        capturedGrounding: 'Some context.',
      }) as never)

      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.errored).toBe(true)
      // Spend was consumed (no refund) — decrby should NOT have been called
      expect(mockDecrby).not.toHaveBeenCalled()
    })
  })

  // ── 4. score POST decrements the same per-IP allowance ──────────────────────

  describe('shared rate-limit bucket', () => {
    it('decrements the shared per-IP rate-limit bucket on each call', async () => {
      mockRlLimit.mockClear()

      await handler(makeReq({
        source: 'captured',
        capturedOutput: 'Patient takes Lisinopril.',
        capturedGrounding: '[medications]\nLisinopril.',
      }) as never)

      // checkRateLimit calls getInstance().limit() — which is mockRlLimit
      expect(mockRlLimit).toHaveBeenCalledTimes(1)
    })

    it('returns 429 when the shared rate-limit bucket is exhausted', async () => {
      mockRlLimit.mockResolvedValueOnce({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 3_600_000,
      })

      const res = await handler(makeReq({
        source: 'captured',
        capturedOutput: 'x',
        capturedGrounding: 'y',
      }) as never)

      expect(res.status).toBe(429)
    })
  })

  // ── 5. malformed rubric → judge-errored response ─────────────────────────────

  describe('malformed rubric handling', () => {
    it('returns errored:true (not a crash) when judge cannot parse the rubric response', async () => {
      // Make all judge calls return unparseable content (simulates malformed rubric
      // causing the model to respond with something the extract validator rejects).
      mockCreate.mockReset()
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not a tool call' }] })

      const res = await handler(makeReq({
        source: 'captured',
        capturedOutput: 'Patient takes Lisinopril.',
        capturedGrounding: '[medications]\nLisinopril.',
        userVerdictRubric: '<<MALFORMED>>: }{invalid rubric text}{',
      }) as never)

      // Must NOT be a 5xx crash — the endpoint should return a graceful response
      expect(res.status).not.toBe(500)
      const body = await res.json() as Record<string, unknown>
      // errored:true with a message, score is null — not a fake score
      expect(body.errored).toBe(true)
      expect(typeof body.errorMessage).toBe('string')
      expect(body.score).toBeNull()
      // claims array should be present but empty
      expect(Array.isArray(body.claims)).toBe(true)
      expect((body.claims as unknown[]).length).toBe(0)
    })
  })

  // ── 6. Validation ────────────────────────────────────────────────────────────

  describe('validation errors', () => {
    it('returns 400 when source is missing', async () => {
      const res = await handler(makeReq({ capturedOutput: 'x', capturedGrounding: 'y' }) as never)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('source')
    })

    it('returns 400 when capturedOutput is missing', async () => {
      const res = await handler(makeReq({ source: 'captured', capturedGrounding: 'y' }) as never)
      expect(res.status).toBe(400)
    })

    it('returns 400 when capturedGrounding is missing for captured source', async () => {
      const res = await handler(makeReq({ source: 'captured', capturedOutput: 'x' }) as never)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('capturedGrounding')
    })

    it('returns 400 for refetch without patientId', async () => {
      const res = await handler(makeReq({
        source: 'refetch',
        capturedOutput: 'x',
        ragMode: 'retrieve',
        query: 'q',
      }) as never)
      expect(res.status).toBe(400)
    })

    it('returns 400 for refetch/retrieve without query', async () => {
      const res = await handler(makeReq({
        source: 'refetch',
        capturedOutput: 'x',
        patientId: 'p1',
        ragMode: 'retrieve',
      }) as never)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('query')
    })

    it('returns 400 for refetch/stuff without record', async () => {
      const res = await handler(makeReq({
        source: 'refetch',
        capturedOutput: 'x',
        patientId: 'p1',
        ragMode: 'stuff',
      }) as never)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(body.error).toContain('record')
    })

    it('returns 400 for unknown source', async () => {
      const res = await handler(makeReq({
        source: 'generate',
        capturedOutput: 'x',
      }) as never)
      expect(res.status).toBe(400)
    })

    it('returns 503 when ANTHROPIC_API_KEY is absent and no BYO key', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        const res = await handler(makeReq({
          source: 'captured',
          capturedOutput: 'x',
          capturedGrounding: 'y',
        }) as never)
        expect(res.status).toBe(503)
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })

    it('BYO key bypasses spend cap and is accepted via header', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        setupJudgeMocks()
        const res = await handler(makeReq(
          { source: 'captured', capturedOutput: 'x', capturedGrounding: 'y' },
          { 'X-Byo-Api-Key': 'sk-ant-test-byo' },
        ) as never)
        // BYO key satisfies the key requirement even without env key
        expect(res.status).not.toBe(503)
        // BYO is spend-cap-exempt — incrby should NOT have been called
        expect(mockIncrby).not.toHaveBeenCalled()
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })
  })
})
