import { describe, it, expect } from 'vitest'
import {
  classifyGenerationOutcome,
  makeStopReasonCapture,
  CONTEXT_OVERFLOW_STOP_REASON,
} from '../stop-reason'

// SHA-78 / arch S25: classify a *successful* (HTTP-200) streamed generation off the
// provider's VERBATIM stop_reason, not the SDK's lossy "unknown" finishReason.

describe('classifyGenerationOutcome()', () => {
  it('flags context_overflow from the raw stop_reason EVEN with partial output', () => {
    // Reviewer (a): the model emits partial text before the window is hit. An
    // empty-output proxy would miss this; the raw stop_reason does not.
    const out = classifyGenerationOutcome({
      rawStopReason: CONTEXT_OVERFLOW_STOP_REASON,
      finishReason: 'unknown',
      output: 'Partial answer that was truncated mid-sentence',
    })
    expect(out).toEqual({
      ok: false,
      kind: 'context_overflow',
      rawStopReason: CONTEXT_OVERFLOW_STOP_REASON,
    })
  })

  it('flags context_overflow even if the SDK reported a non-unknown finishReason', () => {
    // The raw stop_reason is authoritative regardless of the SDK mapping (reviewer c).
    const out = classifyGenerationOutcome({
      rawStopReason: CONTEXT_OVERFLOW_STOP_REASON,
      finishReason: 'length',
      output: '',
    })
    expect(out.ok).toBe(false)
    expect(out).toMatchObject({ kind: 'context_overflow' })
  })

  it('does NOT misclassify another unknown stop_reason as context overflow (reviewer b)', () => {
    // A captured non-overflow stop_reason with empty output → generic abnormal,
    // never the context-overflow remediation.
    const out = classifyGenerationOutcome({
      rawStopReason: 'refusal',
      finishReason: 'unknown',
      output: '',
    })
    expect(out).toMatchObject({ kind: 'abnormal', rawStopReason: 'refusal' })
  })

  it('treats an unknown finish with empty output and NO raw stop_reason as abnormal (generic)', () => {
    const out = classifyGenerationOutcome({ rawStopReason: null, finishReason: 'unknown', output: '' })
    expect(out).toMatchObject({ kind: 'abnormal', rawStopReason: null })
  })

  it('passes a normal finish with output as ok', () => {
    expect(
      classifyGenerationOutcome({ rawStopReason: 'end_turn', finishReason: 'stop', output: 'A complete answer.' }),
    ).toEqual({ ok: true })
  })

  it('passes an unknown finish that STILL produced text (e.g. a refusal message) as ok', () => {
    // A non-empty response is a real, complete output downstream scoring can handle.
    expect(
      classifyGenerationOutcome({ rawStopReason: 'refusal', finishReason: 'unknown', output: 'I cannot help with that.' }),
    ).toEqual({ ok: true })
  })
})

describe('makeStopReasonCapture()', () => {
  function sse(...lines: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const l of lines) controller.enqueue(enc.encode(l))
        controller.close()
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }

  it('reads the verbatim stop_reason from the message_delta SSE frame', async () => {
    const fakeFetch = (async () =>
      sse(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded","stop_sequence":null}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      )) as unknown as typeof fetch

    const cap = makeStopReasonCapture(fakeFetch)
    const res = await cap.fetch('https://api.anthropic.com/v1/messages')
    // Drain the SDK-facing branch (as the SDK would) so the source completes.
    await res.text()
    await cap.done
    expect(cap.stopReason()).toBe('model_context_window_exceeded')
  })

  it('ignores a stop_reason string that appears inside a text delta (no spoofing)', async () => {
    const fakeFetch = (async () =>
      sse(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"\\"stop_reason\\":\\"model_context_window_exceeded\\""}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}\n\n',
      )) as unknown as typeof fetch

    const cap = makeStopReasonCapture(fakeFetch)
    const res = await cap.fetch('https://api.anthropic.com/v1/messages')
    await res.text()
    await cap.done
    expect(cap.stopReason()).toBe('end_turn')
  })

  it('resolves done with null stop_reason for a non-SSE (error/JSON) response', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'request_too_large' }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

    const cap = makeStopReasonCapture(fakeFetch)
    const res = await cap.fetch('https://api.anthropic.com/v1/messages')
    await cap.done
    expect(cap.stopReason()).toBeNull()
    expect(res.status).toBe(413)
  })
})
