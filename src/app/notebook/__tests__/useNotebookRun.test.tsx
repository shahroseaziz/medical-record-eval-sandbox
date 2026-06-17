import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNotebookRun, type NotebookRunCase } from '../useNotebookRun'

// ── Fake /api/run response helpers ───────────────────────────────────────────

/**
 * A 200 streaming Response in the AI SDK data-stream format: text token(s) then a
 * `trace` data frame carrying the producing model id (this is how the id travels
 * back in the response — the card's model stamp).
 */
function streamResponse(text: string, model: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(`0:${JSON.stringify(text)}\n`))
      controller.enqueue(
        enc.encode(`2:${JSON.stringify([{ type: 'trace', trace: { generationModel: model } }])}\n`),
      )
      controller.enqueue(enc.encode(`d:${JSON.stringify({ finishReason: 'stop' })}\n`))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/**
 * A 200 streaming Response that emits a `type:'context'` manifest frame (the
 * "what the model saw" receipt, N2) before the text + trace. Mirrors what
 * /api/run sends so the run loop's capture is tested against the real shape.
 */
function streamWithContext(
  text: string,
  model: string,
  context: Record<string, unknown>,
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(`2:${JSON.stringify([{ type: 'context', ...context }])}\n`))
      controller.enqueue(enc.encode(`0:${JSON.stringify(text)}\n`))
      controller.enqueue(
        enc.encode(`2:${JSON.stringify([{ type: 'trace', trace: { generationModel: model } }])}\n`),
      )
      controller.enqueue(enc.encode(`d:${JSON.stringify({ finishReason: 'stop' })}\n`))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const CASES: NotebookRunCase[] = [
  { patientId: 'p1', record: 'record-1' },
  { patientId: 'p2', record: 'record-2' },
]

describe('useNotebookRun (notebook run loop)', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('streams output per patient and stamps the model id from the response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse('answer-1', 'claude-haiku-4-5-20251001'))
      .mockResolvedValueOnce(streamResponse('answer-2', 'claude-haiku-4-5-20251001'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useNotebookRun())
    await act(async () => {
      await result.current.run(CASES, 'extract meds', { model: 'claude-haiku-4-5-20251001' })
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.results['p1'].status).toBe('done')
    expect(result.current.results['p1'].output).toBe('answer-1')
    // The model stamp is whatever the RESPONSE carried, not a request echo.
    expect(result.current.results['p1'].model).toBe('claude-haiku-4-5-20251001')
    expect(result.current.results['p2'].output).toBe('answer-2')
    expect(result.current.running).toBe(false)
  })

  it('sends the prompt as the query in generate-only stuff mode with the active model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse('out', 'claude-sonnet-4-6'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useNotebookRun())
    await act(async () => {
      await result.current.run([CASES[0]], 'MY-PROMPT', {
        model: 'claude-sonnet-4-6',
        byoKey: 'sk-ant-secret',
      })
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body.query).toBe('MY-PROMPT')
    expect(body.mode).toBe('stuff')
    expect(body.record).toBe('record-1')
    expect(body.model).toBe('claude-sonnet-4-6')
    expect(body.generateOnly).toBe(true)
    // There is no system-prompt editor — generationPrompt is never sent.
    expect(body.generationPrompt).toBeUndefined()
    // The BYO key travels as a header, never in the body.
    expect(init.headers['x-byo-api-key']).toBe('sk-ant-secret')
    expect(init.body).not.toContain('sk-ant-secret')
  })

  it('omits the BYO header on the free tier', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse('out', 'claude-haiku-4-5-20251001'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useNotebookRun())
    await act(async () => {
      await result.current.run([CASES[0]], 'p', { model: 'claude-haiku-4-5-20251001' })
    })
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers['x-byo-api-key']).toBeUndefined()
  })

  it('captures the FULL context manifest from the stream (small patient — chart fit)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamWithContext('out', 'claude-haiku-4-5-20251001', {
        contextMode: 'full',
        sections: [{ section: 'record', chars: 3200 }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useNotebookRun())
    await act(async () => {
      await result.current.run([CASES[0]], 'p', { model: 'claude-haiku-4-5-20251001' })
    })

    const ctx = result.current.results['p1'].context
    expect(ctx?.contextMode).toBe('full')
    expect(ctx?.sections).toEqual([{ section: 'record', chars: 3200 }])
    expect(ctx?.droppedSections).toBeUndefined()
  })

  it('captures the RETRIEVED context manifest + dropped sections (large patient — chart too large)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      streamWithContext('out', 'claude-haiku-4-5-20251001', {
        contextMode: 'retrieved',
        sections: [{ section: 'medications', chars: 21 }],
        droppedSections: ['labs', 'imaging'],
        // Retrieve-mode extras the workbench surface uses are ignored by the card.
        chunks: [{ section: 'medications', text: 'Lisinopril 10mg', distance: 0.1, similarity: 0.9 }],
        groundingContext: '[medications]\nLisinopril 10mg',
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useNotebookRun())
    await act(async () => {
      await result.current.run([CASES[0]], 'p', { model: 'claude-haiku-4-5-20251001' })
    })

    const ctx = result.current.results['p1'].context
    expect(ctx?.contextMode).toBe('retrieved')
    expect(ctx?.sections).toEqual([{ section: 'medications', chars: 21 }])
    expect(ctx?.droppedSections).toEqual(['labs', 'imaging'])
    // Only the manifest fields are kept — no fabricated/leaked chunk text.
    expect(ctx as unknown as Record<string, unknown>).not.toHaveProperty('chunks')
    expect(ctx as unknown as Record<string, unknown>).not.toHaveProperty('groundingContext')
  })

  it('leaves context null when no manifest frame arrives', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse('out', 'claude-haiku-4-5-20251001'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useNotebookRun())
    await act(async () => {
      await result.current.run([CASES[0]], 'p', { model: 'claude-haiku-4-5-20251001' })
    })
    expect(result.current.results['p1'].context).toBeNull()
  })

  it('marks a card errored when the run fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errorResponse(429, 'Free-tier usage limit reached.'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useNotebookRun())
    await act(async () => {
      await result.current.run([CASES[0]], 'p', { model: 'claude-haiku-4-5-20251001' })
    })
    expect(result.current.results['p1'].status).toBe('error')
    expect(result.current.results['p1'].error).toBe('Free-tier usage limit reached.')
  })
})
