import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, renderHook } from '@testing-library/react'

// ── REGRESSION HOLD (SHA-153 N2) ─────────────────────────────────────────────
//
// The retrieve-only `type:'retrieval'` stream frame was replaced by the unified
// `type:'context'` manifest. This test drives the REAL useRun parser with a stream
// carrying the NEW context part, then renders the existing workbench surface
// (GoldenSetBuilder) against the derived retrieval state — asserting it still
// renders, does not crash, and is NOT in an empty state. The old surface must keep
// working against the new frame.

// localStorage / sessionStorage mocks (GoldenSetBuilder + ApiKeyInput read them).
const mockLocalStorage: Record<string, string> = {}
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (k: string) => mockLocalStorage[k] ?? null,
    setItem: (k: string, v: string) => { mockLocalStorage[k] = v },
    removeItem: (k: string) => { delete mockLocalStorage[k] },
    clear: () => { Object.keys(mockLocalStorage).forEach((k) => delete mockLocalStorage[k]) },
  },
  writable: true,
})
Object.defineProperty(window, 'sessionStorage', {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
  writable: true,
})

import { useRun } from '@/hooks/useRun'
import { GoldenSetBuilder } from '../GoldenSetBuilder'

// A retrieve-mode run stream whose pre-generation frame is the NEW context manifest
// (carrying both the documented manifest fields and the rich chunk detail).
const CONTEXT_STREAM = [
  `2:[{"type":"context","contextMode":"retrieved","sections":[{"section":"medications","chars":21}],"droppedSections":["labs"],"chunks":[{"section":"medications","text":"Lisinopril 10mg daily","distance":0.12,"similarity":0.88}],"groundingContext":"[medications]\\nLisinopril 10mg daily"}]`,
  `0:"The patient takes Lisinopril 10mg daily."`,
  `d:{"finishReason":"stop","usage":{"promptTokens":100,"completionTokens":10}}`,
].join('\n')

function makeReadableStream(body: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
}

describe('context manifest — workbench surface regression hold', () => {
  beforeEach(() => {
    Object.keys(mockLocalStorage).forEach((k) => delete mockLocalStorage[k])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeReadableStream(CONTEXT_STREAM),
    }))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('useRun derives retrieval from the type:context part', async () => {
    const { result } = renderHook(() => useRun())

    await act(async () => {
      await result.current.run({ patientId: 'p-1', query: 'What meds?', mode: 'retrieve' })
    })

    expect(result.current.error).toBeNull()
    expect(result.current.retrieval).not.toBeNull()
    expect(result.current.retrieval?.chunks).toHaveLength(1)
    expect(result.current.retrieval?.chunks[0].section).toBe('medications')
    expect(result.current.text).toBe('The patient takes Lisinopril 10mg daily.')
  })

  it('GoldenSetBuilder renders against the new context-derived retrieval (no crash, not empty)', async () => {
    const { result } = renderHook(() => useRun())
    await act(async () => {
      await result.current.run({ patientId: 'p-1', query: 'What meds?', mode: 'retrieve' })
    })

    const retrieval = result.current.retrieval

    // Rendering the existing surface with the new context-derived retrieval must not throw.
    expect(() =>
      render(
        <GoldenSetBuilder
          runOutput="The patient takes Lisinopril 10mg daily."
          retrieval={retrieval}
          currentPatientId="p-1"
          currentQuery="What meds?"
          currentMode="retrieve"
          currentRecord=""
          currentGenPrompt=""
          runGenPrompt=""
          loading={false}
          onRunCase={vi.fn()}
        />,
      ),
    ).not.toThrow()

    // Not an empty state: the surface root and its capture entry point are present.
    expect(screen.getByTestId('golden-set-builder')).toBeInTheDocument()
    expect(screen.getByTestId('capture-from-run-btn')).toBeInTheDocument()
  })
})
