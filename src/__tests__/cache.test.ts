/**
 * Prompt-caching (D8) coverage for /api/run.
 *
 * Asserts:
 *   1. The generation call marks the STATIC prefix (system + record/chunk context)
 *      with Anthropic `cache_control: ephemeral`, and the QUESTION suffix is a
 *      separate, UNcached text part.
 *   2. A cached-prefix run surfaces the provider's cache-read tokens in the trace
 *      token estimates (cacheReadTokens / cacheWriteTokens), and the cost estimate
 *      prices the cache-read leg below a full input leg.
 *   3. buildPromptParts concatenates byte-identically to the legacy single-string
 *      buildPrompt (so token counting / trace assembly are unchanged).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { buildPrompt, buildPromptParts } from '../lib/run/prompt'
import type { RunTrace } from '../app/api/run/types'

// ── Pure unit: split form == legacy single string ────────────────────────────

describe('buildPromptParts (D8 cache split)', () => {
  it('contextPrefix + questionSuffix is byte-identical to buildPrompt.userTurnPrompt', () => {
    const grounding = '[medications]\nLisinopril 10mg daily.'
    const query = 'What medications is the patient on?'
    const parts = buildPromptParts(query, grounding)
    const legacy = buildPrompt(query, grounding)
    expect(`${parts.contextPrefix}${parts.questionSuffix}`).toBe(legacy.userTurnPrompt)
    expect(parts.systemPrompt).toBe(legacy.systemPrompt)
  })

  it('the static prefix carries the record context; the suffix carries the question', () => {
    const parts = buildPromptParts('my question here', '[problems]\nHypertension.')
    expect(parts.contextPrefix).toContain('MEDICAL RECORD CONTEXT')
    expect(parts.contextPrefix).toContain('Hypertension')
    expect(parts.contextPrefix).not.toContain('my question here')
    expect(parts.questionSuffix).toContain('my question here')
  })
})

// ── Route-level: cache_control plumbing + trace cache tokens ──────────────────

function parseDataStreamParts(text: string): Array<{ type: string; value: unknown }> {
  const parts: Array<{ type: string; value: unknown }> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const typeCode = trimmed.slice(0, colonIdx)
    const payload = trimmed.slice(colonIdx + 1)
    try {
      if (typeCode === '2') {
        for (const v of JSON.parse(payload) as unknown[]) parts.push({ type: 'data', value: v })
      } else if (typeCode === '0') {
        parts.push({ type: 'text', value: JSON.parse(payload) })
      }
    } catch {
      /* skip malformed */
    }
  }
  return parts
}

vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: vi.fn(() => ({
      incrby: vi.fn().mockResolvedValue(100),
      decrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    })),
  },
}))

vi.mock('@upstash/ratelimit', () => {
  const mockLimit = vi.fn().mockResolvedValue({
    success: true,
    limit: 10,
    remaining: 9,
    reset: Date.now() + 3_600_000,
  })
  const MockRatelimit = Object.assign(
    vi.fn().mockImplementation(() => ({ limit: mockLimit })),
    { slidingWindow: vi.fn().mockReturnValue({}) },
  )
  return { Ratelimit: MockRatelimit }
})

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ provider: 'anthropic', modelId }),
}))

// streamText is mocked, so the real stop-reason capture's `done` (resolved only
// when the wrapped fetch sees the provider SSE) never fires. Stub it; the pure
// classifier stays real.
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

// Capture the streamText args so we can assert the cache_control plumbing, and
// return a fake result whose providerMetadata reports cache-read/write tokens.
const CACHE_READ_TOKENS = 11_842
const CACHE_WRITE_TOKENS = 0
const streamTextSpy = vi.fn()

vi.mock('ai', () => {
  interface WriterLike {
    writeData(val: unknown): void
    write(data: string): void
    onError: ((e: unknown) => string) | undefined
  }

  const buildResponse = (execute: (w: WriterLike) => Promise<void>) => {
    const chunks: string[] = []
    const writer: WriterLike = {
      writeData(val) {
        chunks.push(`2:${JSON.stringify([val])}\n`)
      },
      write(data) {
        chunks.push(data)
      },
      onError: undefined,
    }
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await execute(writer)
        } catch (e) {
          const msg = writer.onError ? writer.onError(e) : String(e)
          chunks.push(`3:${JSON.stringify(msg)}\n`)
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
    createDataStreamResponse: (opts: {
      execute: (w: WriterLike) => Promise<void>
      onError?: (e: unknown) => string
    }) =>
      buildResponse(async (writer) => {
        writer.onError = opts.onError
        await opts.execute(writer)
      }),
    streamText: (args: unknown) => {
      streamTextSpy(args)
      return {
        text: Promise.resolve('The patient takes Lisinopril 10mg daily.'),
        usage: Promise.resolve({ promptTokens: 120, completionTokens: 20, totalTokens: 140 }),
        finishReason: Promise.resolve('stop'),
        providerMetadata: Promise.resolve({
          anthropic: {
            cacheReadInputTokens: CACHE_READ_TOKENS,
            cacheCreationInputTokens: CACHE_WRITE_TOKENS,
          },
        }),
        mergeIntoDataStream(writer: WriterLike) {
          writer.write(`0:${JSON.stringify('The patient takes Lisinopril 10mg daily.')}\n`)
        },
      }
    },
  }
})

vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn()
  let idx = 0
  mockCreate.mockImplementation(() => {
    const i = idx++
    if (i % 2 === 0) {
      return Promise.resolve({
        content: [{ type: 'tool_use', name: 'extract_claims', input: { claims: ['c'] } }],
      })
    }
    return Promise.resolve({
      content: [
        {
          type: 'tool_use',
          name: 'verdict_claims',
          input: { verdicts: [{ claim: 'c', verdict: 'supported', rationale: 'r' }] },
        },
      ],
    })
  })
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate }
      static APIError = class extends Error {}
    },
  }
})

describe('/api/run prompt caching (D8)', () => {
  let handler: typeof import('../app/api/run/route').POST

  beforeAll(async () => {
    handler = (await import('../app/api/run/route')).POST
  })

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    streamTextSpy.mockClear()
  })

  function makeReq(body: object): Request {
    return new Request('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function extractTrace(body: string): RunTrace | undefined {
    const part = parseDataStreamParts(body).find(
      (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'trace',
    )
    return part ? ((part.value as Record<string, unknown>).trace as RunTrace) : undefined
  }

  it('marks the static prefix with cache_control: ephemeral; question suffix is uncached', async () => {
    const res = await handler(
      makeReq({
        patientId: 'p1',
        query: 'What medications is the patient on?',
        mode: 'stuff',
        record: 'Patient takes Lisinopril 10mg daily for hypertension.',
      }) as never,
    )
    await res.text()

    expect(streamTextSpy).toHaveBeenCalled()
    const args = streamTextSpy.mock.calls.at(-1)![0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>
    }
    const content = args.messages[0].content
    // Two parts: [0] cached static context, [1] uncached question.
    expect(content).toHaveLength(2)
    expect((content[0].text as string)).toContain('MEDICAL RECORD CONTEXT')
    expect((content[0].text as string)).toContain('Lisinopril')
    expect(content[0].providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })
    // The variable question part must NOT carry cache_control.
    expect((content[1].text as string)).toContain('QUESTION')
    expect(content[1].providerOptions).toBeUndefined()
  })

  it('surfaces provider cache-read tokens in the trace token estimates', async () => {
    const res = await handler(
      makeReq({
        patientId: 'p1',
        query: 'What medications is the patient on?',
        mode: 'stuff',
        record: 'Patient takes Lisinopril 10mg daily for hypertension.',
      }) as never,
    )
    const trace = extractTrace(await res.text())
    expect(trace).toBeDefined()
    expect(trace!.tokens.cacheReadTokens).toBe(CACHE_READ_TOKENS)
    expect(trace!.tokens.cacheWriteTokens).toBe(CACHE_WRITE_TOKENS)
    // Cache reads are billed at ~0.1× input, so a warm-hit run costs far less than
    // pricing the same prefix as fresh input would.
    expect(trace!.tokens.estCostUsd).toBeGreaterThan(0)
    const freshPriceOfCacheLeg = CACHE_READ_TOKENS * (0.8 / 1_000_000)
    expect(trace!.tokens.estCostUsd).toBeLessThan(freshPriceOfCacheLeg)
  })
})
