/**
 * Fail-closed behaviour under an Upstash outage (arch S9a).
 *
 * When the Upstash backend is unavailable, the limiter + kill-switch must fail
 * CLOSED for the free tier — never fail OPEN into uncapped shared spend — yet the
 * BYO path (caller's own key, no shared-cap draw) and the static demo (S11,
 * client-only, no server/Upstash call) must survive.
 *
 *   • free-tier + limiter down   → 503, NO booking
 *   • free-tier + killswitch down → 503, NO booking stands
 *   • BYO + Upstash down          → survives (200 stream), never books
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const mockIncrby = vi.fn().mockResolvedValue(100)
const mockDecrby = vi.fn().mockResolvedValue(0)
const mockExpire = vi.fn().mockResolvedValue(1)

vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: vi.fn(() => ({ incrby: mockIncrby, decrby: mockDecrby, expire: mockExpire })),
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

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ provider: 'anthropic', modelId }),
}))

vi.mock('../app/api/run/stop-reason', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/api/run/stop-reason')>()
  return {
    ...actual,
    makeStopReasonCapture: () => ({ fetch: globalThis.fetch, stopReason: () => null, done: Promise.resolve() }),
  }
})

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
    retrieve: vi.fn().mockResolvedValue({ chunks: [], sql: '', summary: '' }),
  }
})

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
    default: class MockAnthropic { messages = { create: mockCreate }; static APIError = class extends Error {} },
    APIError: class extends Error {},
  }
})

function runReq(body: object, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const STUFF_BODY = {
  patientId: 'p1',
  query: 'What medications is the patient on?',
  mode: 'stuff',
  record: 'Patient takes Lisinopril 10mg daily for hypertension.',
}

describe('fail-closed under Upstash outage (S9a)', () => {
  let handler: typeof import('../app/api/run/route').POST

  beforeAll(async () => {
    handler = (await import('../app/api/run/route')).POST
  })

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    mockIncrby.mockClear().mockResolvedValue(100)
    mockDecrby.mockClear()
    mockRlLimit.mockClear().mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + 3_600_000 })
  })

  it('FREE-TIER: limiter Upstash-down → 503 and NO booking', async () => {
    mockRlLimit.mockRejectedValue(new Error('Upstash connection refused'))
    const res = await handler(runReq(STUFF_BODY) as never)
    expect(res.status).toBe(503)
    // Failed closed BEFORE any spend was booked.
    expect(mockIncrby).not.toHaveBeenCalled()
  })

  it('FREE-TIER: killswitch Upstash-down (limiter up) → 503, no booking stands', async () => {
    // Limiter passes; the kill-switch booking hits a dead Upstash and rejects.
    mockIncrby.mockRejectedValue(new Error('Upstash connection refused'))
    const res = await handler(runReq(STUFF_BODY) as never)
    expect(res.status).toBe(503)
    // The INCRBY was attempted but rejected — nothing committed; fail closed, no spend.
    expect(mockIncrby).toHaveBeenCalled()
  })

  it('BYO: survives a limiter Upstash-down (no shared spend at risk) and never books', async () => {
    mockRlLimit.mockRejectedValue(new Error('Upstash connection refused'))
    const res = await handler(
      runReq(STUFF_BODY, { 'X-Byo-Api-Key': 'sk-ant-test-byo-key' }) as never,
    )
    // Not a 503 — the BYO path is exempt from the shared spend cap, so the outage
    // does not take it down (arch S9a "BYO survive").
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Lisinopril') // a real generation streamed
    // BYO never books shared spend, outage or not.
    expect(mockIncrby).not.toHaveBeenCalled()
    expect(mockDecrby).not.toHaveBeenCalled()
  })

  it('BYO: survives even when BOTH limiter and killswitch Upstash are down', async () => {
    mockRlLimit.mockRejectedValue(new Error('Upstash down'))
    mockIncrby.mockRejectedValue(new Error('Upstash down'))
    const res = await handler(
      runReq(STUFF_BODY, { 'X-Byo-Api-Key': 'sk-ant-test-byo-key' }) as never,
    )
    expect(res.status).toBe(200)
    // BYO path skips bookSpend entirely, so the dead killswitch is never touched.
    expect(mockIncrby).not.toHaveBeenCalled()
  })
})
