import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Keep BYO/judge header helpers inert so the hook doesn't touch storage.
vi.mock('@/components/ApiKeyInput', () => ({
  getByoHeaders: () => ({}),
  getJudgeUsesByo: () => false,
}))

import { useGenerationRun, type GenerationCase } from '../useGenerationRun'

// ── Fake /api/run response helpers ───────────────────────────────────────────

/** Build a 200 streaming Response in AI SDK data-stream format emitting `text`. */
function streamResponse(text: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      controller.enqueue(enc.encode(`0:${JSON.stringify(text)}\n`))
      controller.enqueue(enc.encode(`d:${JSON.stringify({ finishReason: 'stop' })}\n`))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: 'Rate limit exceeded.' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  })
}

const CASES: GenerationCase[] = [
  { id: 'a', patientId: 'p1', query: 'q-a', mode: 'stuff', record: 'record-a' },
  { id: 'b', patientId: 'p1', query: 'q-b', mode: 'stuff', record: 'record-b' },
]

describe('useGenerationRun (live-generation fan-out)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('runs N sequential generations and collects each output', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse('output for A'))
      .mockResolvedValueOnce(streamResponse('output for B'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useGenerationRun())

    await act(async () => {
      await result.current.run(CASES, 'my edited prompt')
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.results['a'].status).toBe('done')
    expect(result.current.results['a'].output).toBe('output for A')
    expect(result.current.results['b'].status).toBe('done')
    expect(result.current.results['b'].output).toBe('output for B')
    expect(result.current.completed).toBe(2)
    expect(result.current.running).toBe(false)
    expect(result.current.rateLimited).toBe(false)
  })

  it('sends generateOnly + the edited prompt to /api/run', async () => {
    const fetchMock = vi.fn().mockResolvedValue(streamResponse('out'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useGenerationRun())
    await act(async () => {
      await result.current.run([CASES[0]], 'EDITED-PROMPT')
    })

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init.body as string)
    expect(body.generateOnly).toBe(true)
    expect(body.generationPrompt).toBe('EDITED-PROMPT')
    expect(body.record).toBe('record-a')
  })

  it('stops gracefully on 429 and preserves progress for resume', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse('output for A'))
      .mockResolvedValueOnce(rateLimitResponse())
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useGenerationRun())
    await act(async () => {
      await result.current.run(CASES, 'p')
    })

    expect(result.current.rateLimited).toBe(true)
    expect(result.current.running).toBe(false)
    expect(result.current.completed).toBe(1)
    expect(result.current.results['a'].status).toBe('done')
    expect(result.current.results['b'].status).toBe('pending')

    // Resume: only the rate-limited (pending) case re-runs; A is not re-fetched.
    fetchMock.mockResolvedValueOnce(streamResponse('output for B'))
    await act(async () => {
      await result.current.resume(CASES, 'p')
    })

    expect(fetchMock).toHaveBeenCalledTimes(3) // A(1) + B-429(1) + B-resume(1)
    expect(result.current.results['b'].status).toBe('done')
    expect(result.current.results['b'].output).toBe('output for B')
    expect(result.current.rateLimited).toBe(false)
    expect(result.current.completed).toBe(2)
  })

  it('marks a case as error on a non-429 failure but keeps going', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(streamResponse('output for B'))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useGenerationRun())
    await act(async () => {
      await result.current.run(CASES, 'p')
    })

    expect(result.current.results['a'].status).toBe('error')
    expect(result.current.results['a'].error).toBe('boom')
    expect(result.current.results['b'].status).toBe('done')
    expect(result.current.completed).toBe(2)
  })

  it('abort() stops the run; the in-flight case returns to pending', async () => {
    // First case hangs until its signal aborts, then rejects like a real fetch.
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal
          signal.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useGenerationRun())

    let runPromise: Promise<void>
    act(() => {
      runPromise = result.current.run(CASES, 'p')
    })

    await waitFor(() => expect(result.current.running).toBe(true))

    await act(async () => {
      result.current.abort()
      await runPromise
    })

    expect(result.current.running).toBe(false)
    expect(result.current.results['a'].status).toBe('pending')
    // Second case never started.
    expect(result.current.results['b'].status).toBe('pending')
  })
})
