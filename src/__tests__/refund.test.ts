/**
 * App-fault refund wiring (arch S23 / E29d).
 *
 * The killswitch books estimated spend BEFORE work and returns a refund closure
 * (decrby). An app fault — a token-limit assembly failure or a schema/validation
 * error — must release that booking; a genuine rate-limit 429 must NOT (else the
 * cap is bypassable). These tests drive the REAL /api/run and /api/score handlers
 * with a spy Redis and assert exactly which booking/refund calls fire.
 *
 *   • token-limit fault (run 12k ceiling, score 413) → booked then REFUNDED
 *   • a normal completed run                          → booked, NOT refunded (spend stands)
 *   • a validation fault                              → NEVER booked (nothing to leak)
 *   • a genuine rate-limit 429                        → NEVER booked, NEVER refunded
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

// ── Spy Redis: incrby = booking, decrby = refund ─────────────────────────────
const mockIncrby = vi.fn().mockResolvedValue(100) // well under the cap by default
const mockDecrby = vi.fn().mockResolvedValue(0)
const mockExpire = vi.fn().mockResolvedValue(1)

vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: vi.fn(() => ({ incrby: mockIncrby, decrby: mockDecrby, expire: mockExpire })),
  },
}))

// Rate limiter — controllable per test via mockRlLimit.
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

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ provider: 'anthropic', modelId }),
}))

// streamText mocked → real stop-reason capture's `done` never resolves; stub it.
vi.mock('../app/api/run/stop-reason', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/api/run/stop-reason')>()
  return {
    ...actual,
    makeStopReasonCapture: () => ({
      fetch: globalThis.fetch,
      stopReason: () => null,
      done: Promise.resolve(),
    }),
  }
})

// Trace persistence must SUCCEED so a normal run reaches completion without the
// outer catch firing a (spurious) refund on a DB-write error.
vi.mock('../lib/db/index', () => ({
  withClient: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn().mockResolvedValue({ rows: [] }) }),
  ),
}))

vi.mock('../lib/voyage', () => ({
  MODEL: 'voyage-3.5',
  DIM: 1024,
  embed: vi.fn().mockResolvedValue([[...Array(1024).fill(0.1)]]),
}))

vi.mock('../lib/rag/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rag/index')>()
  return {
    ...actual,
    retrieve: vi.fn().mockResolvedValue({
      chunks: [
        { section: 'medications', text: 'Patient takes Lisinopril 10mg daily.', distance: 0.1, similarity: 0.9 },
      ],
      sql: 'SELECT ...',
      summary: 'retrieved 1 of 5 sections',
    }),
  }
})

// Minimal `ai` mock: a normal run streams one delta and finishes cleanly.
vi.mock('ai', () => {
  interface WriterLike {
    writeData(v: unknown): void
    write(d: string): void
    onError: ((e: unknown) => string) | undefined
  }
  const buildResponse = (execute: (w: WriterLike) => Promise<void>) => {
    const chunks: string[] = []
    const writer: WriterLike = {
      writeData(v) { chunks.push(`2:${JSON.stringify([v])}\n`) },
      write(d) { chunks.push(d) },
      onError: undefined,
    }
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await execute(writer)
        } catch (e) {
          chunks.push(`3:${JSON.stringify(writer.onError ? writer.onError(e) : String(e))}\n`)
        }
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
        controller.close()
      },
    })
    return new Response(readable, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-vercel-ai-data-stream': 'v1' },
    })
  }
  return {
    createDataStreamResponse: (opts: { execute: (w: WriterLike) => Promise<void>; onError?: (e: unknown) => string }) =>
      buildResponse(async (writer) => { writer.onError = opts.onError; await opts.execute(writer) }),
    streamText: () => ({
      text: Promise.resolve('Patient takes Lisinopril 10mg daily.'),
      usage: Promise.resolve({ promptTokens: 120, completionTokens: 20, totalTokens: 140 }),
      finishReason: Promise.resolve('stop'),
      providerMetadata: Promise.resolve(undefined),
      mergeIntoDataStream(w: WriterLike) { w.write(`0:${JSON.stringify('Patient takes Lisinopril 10mg daily.')}\n`) },
    }),
  }
})

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn()
  let idx = 0
  mockCreate.mockImplementation(() => {
    const i = idx++
    if (i % 2 === 0) {
      return Promise.resolve({ content: [{ type: 'tool_use', name: 'extract_claims', input: { claims: ['c'] } }] })
    }
    return Promise.resolve({
      content: [{ type: 'tool_use', name: 'verdict_claims', input: { verdicts: [{ claim: 'c', verdict: 'supported', rationale: 'r' }] } }],
    })
  })
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate }
      static APIError = class extends Error {}
    },
    APIError: class extends Error {},
  }
})

// ── Helpers ──────────────────────────────────────────────────────────────────
function runReq(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
function scoreReq(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('app-fault refund (S23/E29d)', () => {
  let runHandler: typeof import('../app/api/run/route').POST
  let scoreHandler: typeof import('../app/api/score/route').POST

  beforeAll(async () => {
    runHandler = (await import('../app/api/run/route')).POST
    scoreHandler = (await import('../app/api/score/route')).POST
  })

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.VOYAGE_API_KEY = 'test-voyage-key'
    mockIncrby.mockClear().mockResolvedValue(100)
    mockDecrby.mockClear()
    mockRlLimit.mockClear().mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 3_600_000 })
  })

  it('REFUNDS on an injected token-limit assembly fault (/api/run 12k ceiling)', async () => {
    // Prose-density text well over the 12k metered ceiling → the 5b guard rejects
    // the assembled context pre-call. The booking made just above must be released.
    const overTwelveK = 'lorem ipsum dolor '.repeat(2_300)
    const res = await runHandler(
      runReq({ patientId: 'p1', query: 'Summarize.', mode: 'stuff', record: overTwelveK }) as never,
    )
    const body = await res.text()
    expect(body).toContain('12000-token limit')
    expect(mockIncrby).toHaveBeenCalled() // spend was booked
    expect(mockDecrby).toHaveBeenCalled() // …and refunded on the app-fault
  })

  it('REFUNDS on an injected token-limit fault (/api/score oversized input → 413)', async () => {
    const huge = 'word '.repeat(60_000) // ~well over the 12k token cap
    const res = await scoreHandler(
      scoreReq({ source: 'captured', capturedOutput: 'x', capturedGrounding: huge }) as never,
    )
    expect(res.status).toBe(413)
    expect(mockIncrby).toHaveBeenCalled()
    expect(mockDecrby).toHaveBeenCalled()
  })

  it('does NOT refund a normal completed run (spend stands)', async () => {
    const res = await runHandler(
      runReq({ patientId: 'p1', query: 'meds?', mode: 'stuff', record: 'Patient takes Lisinopril 10mg daily.' }) as never,
    )
    await res.text()
    expect(mockIncrby).toHaveBeenCalled() // booked
    expect(mockDecrby).not.toHaveBeenCalled() // consumed, not refunded
  })

  it('a validation fault is NEVER booked (nothing to leak) — /api/run missing patientId', async () => {
    const res = await runHandler(runReq({ query: 'q', mode: 'stuff', record: 'r' }) as never)
    expect(res.status).toBe(400)
    expect(mockIncrby).not.toHaveBeenCalled()
    expect(mockDecrby).not.toHaveBeenCalled()
  })

  it('a validation fault is NEVER booked — /api/score bad source', async () => {
    const res = await scoreHandler(scoreReq({ source: 'nonsense', capturedOutput: 'x' }) as never)
    expect(res.status).toBe(400)
    expect(mockIncrby).not.toHaveBeenCalled()
    expect(mockDecrby).not.toHaveBeenCalled()
  })

  it('a GENUINE rate-limit 429 never books and never refunds', async () => {
    mockRlLimit.mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: Date.now() + 3_600_000 })
    const res = await runHandler(
      runReq({ patientId: 'p1', query: 'meds?', mode: 'stuff', record: 'Patient takes Lisinopril 10mg daily.' }) as never,
    )
    expect(res.status).toBe(429)
    expect(mockIncrby).not.toHaveBeenCalled() // rejected before booking
    expect(mockDecrby).not.toHaveBeenCalled() // genuine 429 never refunds
  })
})
