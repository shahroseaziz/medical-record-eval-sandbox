/**
 * Integration tests for /api/run orchestration.
 *
 * These tests mock Claude and Voyage so no live API keys are needed.
 * They assert:
 *   1. Data-part ORDERING: retrieval first, then tokens, then eval
 *   2. RunTrace shape persisted to the traces table
 *   3. BYO over-context graceful-reject (no raw 400 to client)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { withClient, applySchema } from '../lib/db/index'
import type { RunTrace } from '../app/api/run/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const hasDb = !!process.env.DATABASE_URL

/** Parse the data stream format produced by the AI SDK (Vercel data stream protocol). */
function parseDataStreamParts(text: string): Array<{ type: string; value: unknown }> {
  const parts: Array<{ type: string; value: unknown }> = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Data stream format: `2:[<JSON array>]` (type 2 = data)
    // Text format: `0:"<text>"` (type 0 = text delta)
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue
    const typeCode = trimmed.slice(0, colonIdx)
    const payload = trimmed.slice(colonIdx + 1)
    try {
      if (typeCode === '2') {
        // data parts: array of values
        const arr = JSON.parse(payload) as unknown[]
        for (const v of arr) parts.push({ type: 'data', value: v })
      } else if (typeCode === '0') {
        // text delta
        parts.push({ type: 'text', value: JSON.parse(payload) })
      } else if (typeCode === '3') {
        // error
        parts.push({ type: 'error', value: JSON.parse(payload) })
      } else if (typeCode === 'e' || typeCode === 'd') {
        // finish metadata
        parts.push({ type: 'finish', value: JSON.parse(payload) })
      }
    } catch {
      // skip malformed lines
    }
  }
  return parts
}

// ─── Mock setup ───────────────────────────────────────────────────────────────

// Mock @upstash/redis so rate-limit and killswitch work without real Upstash
vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: vi.fn(() => ({
      incrby: vi.fn().mockResolvedValue(100),
      decrby: vi.fn().mockResolvedValue(0),
      expire: vi.fn().mockResolvedValue(1),
    })),
  },
}))

// Mock @upstash/ratelimit so all requests pass (no real Redis needed)
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

// Mock @ai-sdk/anthropic to avoid real API calls
vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (modelId: string) => ({ provider: 'anthropic', modelId }),
}))

// Mock Voyage embed so retrieve() doesn't need a real API key
vi.mock('../lib/voyage', () => ({
  MODEL: 'voyage-3.5',
  DIM: 1024,
  embed: vi.fn().mockResolvedValue([[...Array(1024).fill(0.1)]]),
}))

// Mock lib/rag retrieve so we can control what chunks come back. Keep the real
// fitChunksToBudget (a pure function, no DB) so the budget-bounded assembly path
// is exercised end-to-end.
vi.mock('../lib/rag/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rag/index')>()
  return {
    ...actual,
    retrieve: vi.fn().mockResolvedValue({
      chunks: [
        { section: 'medications', text: 'Patient takes Lisinopril 10mg daily.', distance: 0.1, similarity: 0.9 },
        { section: 'problems', text: 'Hypertension diagnosed 2020.', distance: 0.2, similarity: 0.8 },
      ],
      sql: 'SELECT ...',
      summary: 'retrieved 2 of 10 sections',
    }),
  }
})

// Mock the AI SDK streamText to produce controlled text output
const MOCK_OUTPUT = 'The patient takes Lisinopril 10mg daily for hypertension.'

vi.mock('ai', () => {
  // Build a minimal data stream response that emits one text delta then finishes
  const buildResponse = (execute: (w: DataStreamWriterLike) => Promise<void>) => {
    const chunks: string[] = []
    let closed = false

    const writer: DataStreamWriterLike = {
      writeData(val: unknown) {
        chunks.push(`2:${JSON.stringify([val])}\n`)
      },
      write(data: string) {
        chunks.push(data)
      },
      merge(stream: ReadableStream<Uint8Array>) {
        // Collect async from stream - we'll resolve on read
        stream.pipeTo(
          new WritableStream({
            write(chunk) {
              chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
            },
          })
        ).catch(() => {})
      },
      onError: undefined as ((e: unknown) => string) | undefined,
    }

    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await execute(writer)
        } catch (e) {
          const msg = writer.onError ? writer.onError(e) : (e instanceof Error ? e.message : String(e))
          chunks.push(`3:${JSON.stringify(msg)}\n`)
        }
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk))
        }
        controller.close()
        closed = true
      },
    })

    return new Response(readable, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'x-vercel-ai-data-stream': 'v1' },
    })
  }

  interface DataStreamWriterLike {
    writeData(val: unknown): void
    write(data: string): void
    merge(stream: ReadableStream<Uint8Array>): void
    onError: ((e: unknown) => string) | undefined
  }

  // Fake StreamTextResult
  const makeFakeResult = (text: string, usage = { promptTokens: 50, completionTokens: 20, totalTokens: 70 }) => ({
    text: Promise.resolve(text),
    usage: Promise.resolve(usage),
    mergeIntoDataStream(writer: DataStreamWriterLike) {
      // Emit one text delta in data stream format
      writer.write(`0:${JSON.stringify(text)}\n`)
    },
  })

  return {
    createDataStreamResponse: (opts: {
      execute: (w: DataStreamWriterLike) => Promise<void>
      onError?: (e: unknown) => string
    }) => {
      return buildResponse(async (writer) => {
        writer.onError = opts.onError
        await opts.execute(writer)
      })
    },
    streamText: vi.fn().mockReturnValue(makeFakeResult(MOCK_OUTPUT)),
  }
})

// Mock @anthropic-ai/sdk for the judge client
vi.mock('@anthropic-ai/sdk', () => {
  const APIError = class extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }

  const mockCreate = vi.fn()
  // Default: return extract then verdict
  mockCreate
    .mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        name: 'extract_claims',
        input: { claims: ['Patient takes Lisinopril 10mg daily.'] },
      }],
    })
    .mockResolvedValueOnce({
      content: [{
        type: 'tool_use',
        name: 'verdict_claims',
        input: {
          verdicts: [{
            claim: 'Patient takes Lisinopril 10mg daily.',
            verdict: 'supported',
            rationale: 'Explicitly stated in medications section.',
          }],
        },
      }],
    })

  // Always returns a small token count so the 12k guardrail doesn't trip on test inputs
  const mockCountTokens = vi.fn().mockResolvedValue({ input_tokens: 50 })

  return {
    default: class MockAnthropic {
      messages = { create: mockCreate, countTokens: mockCountTokens }
      static APIError = APIError
    },
    APIError,
    __mockCreate: mockCreate,
    __mockCountTokens: mockCountTokens,
  }
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('/api/run orchestration (mocked Claude/Voyage)', () => {
  let handler: typeof import('../app/api/run/route').POST

  beforeAll(async () => {
    // Dynamic import AFTER mocks are in place
    const mod = await import('../app/api/run/route')
    handler = mod.POST
  })

  function makeReq(body: object, extraHeaders: Record<string, string> = {}): Request {
    return new Request('http://localhost/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
    })
  }

  describe('validation', () => {
    it('returns 400 when patientId is missing', async () => {
      const res = await handler(makeReq({ query: 'q', mode: 'stuff', record: 'r' }) as never)
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toContain('patientId')
    })

    it('returns 400 for unknown mode', async () => {
      const res = await handler(makeReq({ patientId: 'p1', query: 'q', mode: 'unknown' }) as never)
      expect(res.status).toBe(400)
      const json = await res.json() as { error: string }
      expect(json.error).toContain('mode')
    })

    it('returns 400 when stuff mode has no record', async () => {
      const res = await handler(
        makeReq({ patientId: 'p1', query: 'q', mode: 'stuff' }) as never
      )
      expect(res.status).toBe(400)
    })

    it('returns 503 when ANTHROPIC_API_KEY is missing', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        const res = await handler(
          makeReq({ patientId: 'p1', query: 'q', mode: 'stuff', record: 'r' }) as never
        )
        expect(res.status).toBe(503)
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })

    it('accepts BYO key via X-Byo-Api-Key header when env key is absent', async () => {
      const saved = process.env.ANTHROPIC_API_KEY
      delete process.env.ANTHROPIC_API_KEY
      try {
        const res = await handler(
          makeReq(
            { patientId: 'p1', query: 'q', mode: 'stuff', record: 'r' },
            { 'X-Byo-Api-Key': 'sk-ant-test-byo-key' },
          ) as never
        )
        // Should NOT return 503 — BYO key satisfies the key requirement
        expect(res.status).not.toBe(503)
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      }
    })
  })

  describe('data-part ordering (stuff mode)', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
    })

    it('emits text tokens before eval part', async () => {
      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'stuff',
          record: 'Patient takes Lisinopril 10mg daily for hypertension.',
        }) as never
      )

      const body = await res.text()
      const parts = parseDataStreamParts(body)

      const textIdx = parts.findIndex((p) => p.type === 'text')
      const evalIdx = parts.findIndex(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'eval'
      )

      expect(textIdx).toBeGreaterThanOrEqual(0)
      expect(evalIdx).toBeGreaterThan(textIdx)
    })

    it('eval data part contains faithfulness and sectionHit', async () => {
      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'stuff',
          record: 'Patient takes Lisinopril 10mg daily for hypertension.',
        }) as never
      )

      const body = await res.text()
      const parts = parseDataStreamParts(body)
      const evalPart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'eval'
      )

      expect(evalPart).toBeDefined()
      const val = evalPart!.value as Record<string, unknown>
      expect(val).toHaveProperty('faithfulness')
      expect(val).toHaveProperty('sectionHit')

      const faithfulness = val.faithfulness as Record<string, unknown>
      expect(faithfulness).toHaveProperty('scorer', 'faithfulness')
      expect(faithfulness).toHaveProperty('score')
      expect(faithfulness).toHaveProperty('claims')
    })
  })

  describe('data-part ordering (retrieve mode)', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
      process.env.VOYAGE_API_KEY = 'test-voyage-key'
    })

    it('emits retrieval part FIRST, then text tokens, then eval', async () => {
      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'retrieve',
          k: 2,
        }) as never
      )

      const body = await res.text()
      const parts = parseDataStreamParts(body)

      const retrievalIdx = parts.findIndex(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'retrieval'
      )
      const textIdx = parts.findIndex((p) => p.type === 'text')
      const evalIdx = parts.findIndex(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'eval'
      )

      expect(retrievalIdx).toBeGreaterThanOrEqual(0)
      expect(textIdx).toBeGreaterThan(retrievalIdx)
      expect(evalIdx).toBeGreaterThan(textIdx)
    })

    it('retrieval data part contains chunks with distance and similarity', async () => {
      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'retrieve',
        }) as never
      )

      const body = await res.text()
      const parts = parseDataStreamParts(body)
      const retrievalPart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'retrieval'
      )

      expect(retrievalPart).toBeDefined()
      const val = retrievalPart!.value as Record<string, unknown>
      const chunks = val.chunks as Array<Record<string, unknown>>
      expect(Array.isArray(chunks)).toBe(true)
      expect(chunks.length).toBeGreaterThan(0)
      expect(typeof chunks[0].distance).toBe('number')
      expect(typeof chunks[0].similarity).toBe('number')
    })
  })

  describe('BYO over-context graceful reject', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
    })

    it('returns graceful error data part when prompt exceeds context limit', async () => {
      // Pass a record so large that estimateTokens exceeds MODEL_CONTEXT_LIMIT
      const hugeRecord = 'x'.repeat(190_000 * 4 + 100)  // ~190k+ tokens

      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'Summarize.',
          mode: 'stuff',
          record: hugeRecord,
        }) as never
      )

      const body = await res.text()
      const parts = parseDataStreamParts(body)
      const errorPart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'error'
      )

      expect(errorPart).toBeDefined()
      const val = errorPart!.value as Record<string, unknown>
      expect(typeof val.message).toBe('string')
      expect((val.message as string).toLowerCase()).toContain('context')
    })

    it('never returns a 400 status — always 200 with error in stream body', async () => {
      const hugeRecord = 'x'.repeat(190_000 * 4 + 100)

      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'Summarize.',
          mode: 'stuff',
          record: hugeRecord,
        }) as never
      )

      expect(res.status).toBe(200)
    })
  })

  describe('BYO lifts the 12k free-tier input ceiling', () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
    })

    // SHA-78: the 12k ceiling is now a LOCAL approximation (no count_tokens API
    // call), so over-limit is driven by real input size. ~30k chars of dense
    // text estimates to ~15.7k tokens — over the 12k ceiling, under the 190k guard.
    const overTwelveK = 'lorem ipsum dolor '.repeat(1_700) // ~30k chars

    it('FREE-TIER: still rejects a >12k context with the 12k limit error', async () => {
      const res = await handler(
        makeReq({ patientId: 'p1', query: 'Summarize.', mode: 'stuff', record: overTwelveK }) as never
      )
      const parts = parseDataStreamParts(await res.text())
      const errorPart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'error'
      )
      expect(errorPart).toBeDefined()
      expect(String((errorPart!.value as Record<string, unknown>).message)).toContain('12000-token limit')
    })

    it('BYO: skips the 12k ceiling entirely (the BYO key lifts it)', async () => {
      const res = await handler(
        makeReq(
          { patientId: 'p1', query: 'Summarize.', mode: 'stuff', record: overTwelveK },
          { 'X-Byo-Api-Key': 'sk-ant-test-byo-key' },
        ) as never
      )
      // The 12k pre-check is gated on !isByo, so a BYO caller never hits it.
      const parts = parseDataStreamParts(await res.text())
      const ceilingError = parts.find(
        (p) => p.type === 'data'
          && (p.value as Record<string, unknown>)?.type === 'error'
          && String((p.value as Record<string, unknown>).message).includes('12000-token limit')
      )
      expect(ceilingError).toBeUndefined()
      expect(res.status).toBe(200)
    })
  })

  // ── P2: custom generationPrompt + grounding exposure ────────────────────────

  describe('custom generationPrompt + grounding exposure (P2)', () => {
    const CUSTOM_PROMPT = 'CANARY_CUSTOM_PROMPT_XYZ: You are a specialized test assistant.'

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockCreate: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockStreamTextFn: any

    beforeAll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreate = ((await import('@anthropic-ai/sdk')) as any).__mockCreate
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockStreamTextFn = (await import('ai') as any).streamText
    })

    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
      process.env.VOYAGE_API_KEY = 'test-voyage-key'
      // Reset to stable alternating extract/verdict responses, independent of prior test state.
      mockCreate.mockReset()
      let callIdx = 0
      mockCreate.mockImplementation(() => {
        const idx = callIdx++
        if (idx % 2 === 0) {
          return Promise.resolve({
            content: [{
              type: 'tool_use',
              name: 'extract_claims',
              input: { claims: ['The patient takes medication.'] },
            }],
          })
        }
        return Promise.resolve({
          content: [{
            type: 'tool_use',
            name: 'verdict_claims',
            input: {
              verdicts: [{
                claim: 'The patient takes medication.',
                verdict: 'supported',
                rationale: 'Stated in grounding.',
              }],
            },
          }],
        })
      })
      mockStreamTextFn.mockClear()
    })

    function extractTrace(body: string): RunTrace | undefined {
      const parts = parseDataStreamParts(body)
      const tracePart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'trace'
      )
      if (!tracePart) return undefined
      return (tracePart.value as Record<string, unknown>).trace as RunTrace
    }

    it('custom generationPrompt is forwarded as system param to streamText (end-to-end plumbing)', async () => {
      const res = await handler(makeReq({
        patientId: 'p1',
        query: 'What medications is the patient on?',
        mode: 'stuff',
        record: 'Patient takes Lisinopril 10mg daily.',
        generationPrompt: CUSTOM_PROMPT,
      }) as never)
      await res.text()  // drain stream so execute() completes

      const calls = mockStreamTextFn.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      const lastArgs = calls[calls.length - 1][0]
      expect(lastArgs.system).toBe(CUSTOM_PROMPT)
    })

    it('default prompt reproduces prior behavior when generationPrompt is absent', async () => {
      const res = await handler(makeReq({
        patientId: 'p1',
        query: 'What medications is the patient on?',
        mode: 'retrieve',
      }) as never)

      const trace = extractTrace(await res.text())
      expect(trace).toBeDefined()
      expect(trace!.generationPromptIsUserAuthored).toBe(false)
      // Default (example-authored) prompt is logged in full — not redacted
      expect(trace!.retrieval?.assembledPrompt).toContain('medical record analyst')

      const calls = mockStreamTextFn.mock.calls
      const lastArgs = calls[calls.length - 1][0]
      expect(lastArgs.system).toContain('medical record analyst')
    })

    it('no user-supplied prompt text survives in any trace field (CI grep-test)', async () => {
      const res = await handler(makeReq({
        patientId: 'p1',
        query: 'What medications is the patient on?',
        mode: 'retrieve',
        generationPrompt: CUSTOM_PROMPT,
      }) as never)

      const trace = extractTrace(await res.text())
      expect(trace).toBeDefined()
      expect(trace!.generationPromptIsUserAuthored).toBe(true)

      const traceJson = JSON.stringify(trace)
      // Neither the canary nor any fragment of the user-authored prompt may persist
      expect(traceJson).not.toContain('CANARY_CUSTOM_PROMPT_XYZ')
      expect(traceJson).not.toContain(CUSTOM_PROMPT)

      // assembledPrompt is a redaction marker (hash + length), never the raw text
      expect(trace!.retrieval?.assembledPrompt).toMatch(/^\[REDACTED sha256=[0-9a-f]+ length=\d+\]$/)
    })

    it('run result exposes grounding in trace for retrieve mode (for UI capture)', async () => {
      const res = await handler(makeReq({
        patientId: 'p1',
        query: 'What medications is the patient on?',
        mode: 'retrieve',
      }) as never)

      const trace = extractTrace(await res.text())
      expect(trace).toBeDefined()
      expect(typeof trace!.grounding).toBe('string')
      expect(trace!.grounding.length).toBeGreaterThan(0)
      // The mock retrieve() returns a Lisinopril chunk — grounding should contain it
      expect(trace!.grounding).toContain('Lisinopril')
    })

    it('run result exposes grounding in trace for stuff mode (for UI capture)', async () => {
      const RECORD = 'Patient takes Lisinopril 10mg daily for hypertension.'
      const res = await handler(makeReq({
        patientId: 'p1',
        query: 'What medications is the patient on?',
        mode: 'stuff',
        record: RECORD,
      }) as never)

      const trace = extractTrace(await res.text())
      expect(trace).toBeDefined()
      expect(typeof trace!.grounding).toBe('string')
      expect(trace!.grounding).toContain('Lisinopril')
    })
  })

  // ── R1: generate-only mode (live-generation fan-out) ────────────────────────

  describe('generate-only mode (R1)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mockCreate: any

    beforeAll(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockCreate = ((await import('@anthropic-ai/sdk')) as any).__mockCreate
    })

    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
      mockCreate.mockReset()
    })

    function makeReq(body: object): Request {
      return new Request('http://localhost/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    it('streams generation but emits NO eval part', async () => {
      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'stuff',
          record: 'Patient takes Lisinopril 10mg daily for hypertension.',
          generateOnly: true,
        }) as never,
      )

      const parts = parseDataStreamParts(await res.text())
      const textIdx = parts.findIndex((p) => p.type === 'text')
      const evalPart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'eval',
      )

      expect(textIdx).toBeGreaterThanOrEqual(0) // generation still streams
      expect(evalPart).toBeUndefined() // but no faithfulness eval
    })

    it('never calls the faithfulness judge', async () => {
      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'stuff',
          record: 'Patient takes Lisinopril 10mg daily for hypertension.',
          generateOnly: true,
        }) as never,
      )
      await res.text() // drain so execute() completes

      // The judge client's messages.create is the only Anthropic call besides
      // generation (which is mocked separately via streamText). Zero calls means
      // the faithfulness judge was skipped.
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('still persists a trace with section-hit and zero claims', async () => {
      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'stuff',
          record: 'Patient takes Lisinopril 10mg daily for hypertension.',
          generateOnly: true,
        }) as never,
      )

      const parts = parseDataStreamParts(await res.text())
      const tracePart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'trace',
      )
      expect(tracePart).toBeDefined()
      const trace = (tracePart!.value as Record<string, unknown>).trace as RunTrace
      expect(trace.output.length).toBeGreaterThan(0)
      expect(trace.sectionHit).toHaveProperty('scorer', 'section-hit')
      expect(trace.claimCount).toBe(0)
      expect(trace.scorerResults).toHaveLength(1)
    })

    it('default mode (generateOnly omitted) still emits the eval part', async () => {
      // Re-arm the alternating extract/verdict judge responses for this one run.
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

      const res = await handler(
        makeReq({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'stuff',
          record: 'Patient takes Lisinopril 10mg daily for hypertension.',
        }) as never,
      )

      const parts = parseDataStreamParts(await res.text())
      const evalPart = parts.find(
        (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'eval',
      )
      expect(evalPart).toBeDefined()
      expect(mockCreate).toHaveBeenCalled()
    })
  })
})

// ─── DB trace persistence (requires DATABASE_URL) ─────────────────────────────

describe.skipIf(!hasDb)('RunTrace DB persistence (live DB)', () => {
  beforeAll(async () => {
    await withClient(async (client) => {
      await applySchema(client)
      await client.query('DELETE FROM traces')
    })
  })

  it('persists a RunTrace with the correct shape after a run', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    process.env.VOYAGE_API_KEY = 'test-voyage-key'

    const { POST } = await import('../app/api/run/route')
    const res = await POST(
      new Request('http://localhost/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientId: 'p1',
          query: 'What medications is the patient on?',
          mode: 'stuff',
          record: 'Patient takes Lisinopril 10mg daily for hypertension.',
        }),
      }) as never
    )

    // Drain the stream and capture the caseId of the trace THIS run produced.
    // The `traces` table is shared across all integration test files, which run
    // in parallel workers against the same DATABASE_URL in CI. An unscoped
    // `SELECT ... LIMIT 1` can return a score / score-reference trace written by
    // another file (those have no `ragMode`), so scope the read to this run's
    // caseId — emitted in the stream as the `trace` data part.
    const body = await res.text()
    const tracePart = parseDataStreamParts(body).find(
      (p) => p.type === 'data' && (p.value as Record<string, unknown>)?.type === 'trace'
    )
    expect(tracePart).toBeDefined()
    const streamedTrace = (tracePart!.value as Record<string, unknown>).trace as RunTrace
    const caseId = streamedTrace.caseId

    const traces = await withClient(async (client) => {
      const r = await client.query<{ trace: RunTrace }>(
        "SELECT trace FROM traces WHERE trace->>'caseId' = $1 LIMIT 1",
        [caseId],
      )
      return r.rows
    })

    expect(traces.length).toBeGreaterThan(0)
    const trace = traces[0].trace

    // Verify RunTrace shape
    expect(typeof trace.caseId).toBe('string')
    expect(trace.ragMode).toBe('stuff')
    expect(trace.retrieval).toBeUndefined()
    expect(trace.inputType).toBe('query')
    expect(typeof trace.output).toBe('string')
    expect(typeof trace.outputLength).toBe('number')
    expect(typeof trace.claimCount).toBe('number')
    expect(trace.tokens).toHaveProperty('input')
    expect(trace.tokens).toHaveProperty('output')
    expect(trace.tokens).toHaveProperty('estCostUsd')
    expect(trace.sectionHit).toHaveProperty('scorer', 'section-hit')
    expect(Array.isArray(trace.scorerResults)).toBe(true)
    expect(trace.generationModel).toBe('claude-haiku-4-5-20251001')
    expect(trace.judgeModel).toBe('claude-haiku-4-5-20251001')
    expect(trace.embeddingModel).toBe('none')
    // P2: grounding and prompt-authorship fields
    expect(typeof trace.grounding).toBe('string')
    expect(trace.grounding.length).toBeGreaterThan(0)
    expect(trace.generationPromptIsUserAuthored).toBe(false)
  }, 60_000)
})
