/**
 * Integration tests for /api/score-reference.
 *
 * Covers:
 *   1. actual-vs-expected scoring (happy path) with defined score + threshold
 *   2. judge error surfaces as errored:true (E13) — never a fabricated verdict
 *   3. refund booked on abort (outer error path)
 *   4. a score-reference POST decrements the SAME per-IP allowance as /api/run
 *      and books killswitch spend
 *   5. trace redaction — the expected-bearing prompt is never persisted raw
 *   6. validation errors + token-limit guard + key handling
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

// Capture every INSERT so we can assert the persisted trace is redacted.
const mockQuery = vi.fn().mockResolvedValue({ rows: [] })
vi.mock('../lib/db/index', () => ({
  withClient: vi.fn(async (fn: (c: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery }),
  ),
}))

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate }
  },
}))

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeReq(body: object, extraHeaders: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/score-reference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  })
}

function setupJudgeMock(verdict = 'equivalent', reason = 'same meaning') {
  mockCreate.mockReset()
  mockCreate.mockResolvedValue({
    content: [{ type: 'tool_use', name: 'reference_verdict', input: { verdict, reason } }],
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/api/score-reference integration (mocked Claude)', () => {
  let handler: typeof import('../app/api/score-reference/route').POST

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    const mod = await import('../app/api/score-reference/route')
    handler = mod.POST
  })

  beforeEach(() => {
    setupJudgeMock()
    mockIncrby.mockClear()
    mockDecrby.mockClear()
    mockQuery.mockClear()
    mockIncrby.mockResolvedValue(100)
    mockDecrby.mockResolvedValue(0)
  })

  // ── 1. happy path ─────────────────────────────────────────────────────────

  describe('actual-vs-expected scoring', () => {
    it('returns 200 with score, verdict, threshold and passed', async () => {
      const res = await handler(
        makeReq({ actual: 'Patient on Lisinopril.', expected: 'Takes Lisinopril.' }) as never,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.score).toBe(1.0)
      expect(body.verdict).toBe('equivalent')
      expect(typeof body.threshold).toBe('number')
      expect(body.passed).toBe(true)
      expect(typeof body.reason).toBe('string')
    })

    it('partial verdict (0.5) fails the 0.8 threshold', async () => {
      setupJudgeMock('partial', 'misses dosage')
      const res = await handler(
        makeReq({ actual: 'Patient on Lisinopril.', expected: 'Lisinopril 10mg daily.' }) as never,
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.score).toBe(0.5)
      expect(body.passed).toBe(false)
    })
  })

  // ── 2. errored, not fabricated ──────────────────────────────────────────────

  describe('judge error (E13)', () => {
    it('returns errored:true with null score/verdict/passed when judge is unparseable', async () => {
      mockCreate.mockReset()
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not a tool call' }] })

      const res = await handler(makeReq({ actual: 'a', expected: 'b' }) as never)
      expect(res.status).not.toBe(500)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.errored).toBe(true)
      expect(typeof body.errorMessage).toBe('string')
      expect(body.score).toBeNull()
      expect(body.verdict).toBeNull()
      expect(body.passed).toBeNull()
      // Spend consumed (swallowed judge error) — no refund.
      expect(mockDecrby).not.toHaveBeenCalled()
    })
  })

  // ── 3. refund on abort ──────────────────────────────────────────────────────

  describe('refund on abort', () => {
    it('calls decrby (refund) when the request is aborted mid-flight', async () => {
      const controller = new AbortController()
      mockCreate.mockReset()
      mockCreate.mockImplementation(() => {
        controller.abort()
        return new Promise(() => {})
      })

      const reqWithSignal = new Request('http://localhost/api/score-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actual: 'a', expected: 'b' }),
        signal: controller.signal,
      })

      const res = await handler(reqWithSignal as never)
      expect(res.status).toBe(503)
      expect(mockDecrby).toHaveBeenCalled()
    })
  })

  // ── 4. shared rate-limit bucket + spend booking ─────────────────────────────

  describe('shared per-IP guardrails', () => {
    it('decrements the shared rate-limit bucket and books killswitch spend', async () => {
      mockRlLimit.mockClear()
      mockIncrby.mockClear()
      await handler(makeReq({ actual: 'x', expected: 'y' }) as never)
      expect(mockRlLimit).toHaveBeenCalledTimes(1)
      expect(mockIncrby).toHaveBeenCalled()
    })

    it('returns 429 when the rate-limit bucket is exhausted', async () => {
      mockRlLimit.mockResolvedValueOnce({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 3_600_000,
      })
      const res = await handler(makeReq({ actual: 'x', expected: 'y' }) as never)
      expect(res.status).toBe(429)
    })

    it('returns 429 when the spend cap is exceeded', async () => {
      // incrby returns a value above the daily cap -> SpendCapError -> 429
      mockIncrby.mockResolvedValueOnce(9_999_999_999).mockResolvedValueOnce(1)
      const res = await handler(makeReq({ actual: 'x', expected: 'y' }) as never)
      expect(res.status).toBe(429)
    })
  })

  // ── 5. trace redaction ──────────────────────────────────────────────────────

  describe('trace redaction', () => {
    it('persists a trace whose prompt never contains raw expected/actual text', async () => {
      const res = await handler(
        makeReq({ actual: 'SECRET_ACTUAL_TXT', expected: 'SECRET_EXPECTED_TXT' }) as never,
      )
      expect(res.status).toBe(200)
      expect(mockQuery).toHaveBeenCalled()
      const persisted = JSON.stringify(mockQuery.mock.calls[0]?.[1])
      expect(persisted).not.toContain('SECRET_ACTUAL_TXT')
      expect(persisted).not.toContain('SECRET_EXPECTED_TXT')
      expect(persisted).toContain('sha256=')
    })

    it('the response body never echoes raw criteria text', async () => {
      const res = await handler(
        makeReq({ actual: 'a', expected: 'b', criteria: 'SECRET_CRITERIA_TXT' }) as never,
      )
      const body = (await res.json()) as Record<string, unknown>
      expect(JSON.stringify(body)).not.toContain('SECRET_CRITERIA_TXT')
      expect(body.criteriaMeta as string).toMatch(/sha256=[0-9a-f]+ len=\d+/)
    })
  })

  // ── 6. validation + guards ──────────────────────────────────────────────────

  describe('validation', () => {
    it('400 when actual is missing', async () => {
      const res = await handler(makeReq({ expected: 'y' }) as never)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('actual')
    })

    it('400 when expected is missing', async () => {
      const res = await handler(makeReq({ actual: 'x' }) as never)
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('expected')
    })

    it('400 on invalid JSON', async () => {
      const req = new Request('http://localhost/api/score-reference', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      })
      const res = await handler(req as never)
      expect(res.status).toBe(400)
    })

    it('413 when combined input exceeds the token limit', async () => {
      const large = 'x'.repeat(50_000)
      const res = await handler(makeReq({ actual: 'a', expected: large }) as never)
      expect(res.status).toBe(413)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('token limit')
    })

    it('503 when no API key and no BYO key', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        const res = await handler(makeReq({ actual: 'x', expected: 'y' }) as never)
        expect(res.status).toBe(503)
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })

    it('BYO key bypasses the spend cap and is accepted via header', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        setupJudgeMock()
        const res = await handler(
          makeReq({ actual: 'x', expected: 'y' }, { 'X-Byo-Api-Key': 'sk-ant-test-byo' }) as never,
        )
        expect(res.status).not.toBe(503)
        expect(mockIncrby).not.toHaveBeenCalled()
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })
  })
})
