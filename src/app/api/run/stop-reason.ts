// Authoritative detection of the Anthropic generation stop_reason — SHA-78 / arch
// S25, "model_context_window_exceeded as an app-fault class".
//
// Anthropic reports the model's stop_reason in the terminal `message_delta` SSE
// frame of a *successful* (HTTP-200) streamed response. The AI SDK collapses
// every stop_reason it does not explicitly recognise — including
// "model_context_window_exceeded", "refusal", and "pause_turn" — to finishReason
// "unknown" and does NOT surface the raw string anywhere (providerMetadata carries
// only cache-token counts). Relying on finishReason === "unknown" is therefore
// fragile in three ways:
//   (a) the model can emit PARTIAL output before the window is hit, so an
//       empty-output proxy lets truncated answers through as "complete";
//   (b) other unknown stop_reasons (refusal/pause) would be misclassified as a
//       context overflow and get the wrong remediation copy;
//   (c) the SDK's stop_reason→finishReason mapping is version-dependent, so a
//       minor dep bump silently changes the classification.
// We instead tee the raw SSE response and read the provider's verbatim stop_reason
// ourselves. The wire format (a `message_delta` event carrying `delta.stop_reason`)
// is part of the Anthropic API contract and is stable across SDK versions.

export const CONTEXT_OVERFLOW_STOP_REASON = 'model_context_window_exceeded'

export interface StopReasonCapture {
  /** fetch wrapper to hand to createAnthropic({ fetch }). */
  fetch: typeof fetch
  /** The provider's verbatim stop_reason once the stream completes, else null. */
  stopReason(): string | null
  /** Resolves when SSE scanning finishes; await before reading stopReason(). */
  readonly done: Promise<void>
}

export function makeStopReasonCapture(baseFetch: typeof fetch = fetch): StopReasonCapture {
  let stopReason: string | null = null
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  const wrapped: typeof fetch = async (input, init) => {
    const res = await baseFetch(input as RequestInfo, init)
    const contentType = res.headers.get('content-type') ?? ''
    // Non-streaming responses (errors, JSON) carry no message_delta to scan.
    if (!res.body || !contentType.includes('text/event-stream')) {
      resolveDone()
      return res
    }
    const [forSdk, forScan] = res.body.tee()
    // Scan the second branch independently; it drives the source to completion
    // even if the SDK abandons its branch, so `done` always resolves.
    void scan(forScan).finally(resolveDone)
    return new Response(forSdk, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }

  async function scan(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done: d, value } = await reader.read()
        if (d) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          // Only the message_delta frame carries the terminal stop_reason; skip
          // text deltas so a model echoing the literal string can't spoof it.
          if (!line.includes('"message_delta"')) continue
          const m = line.match(/"stop_reason"\s*:\s*"([^"]+)"/)
          if (m) stopReason = m[1]
        }
      }
    } catch {
      // Best-effort: leave stopReason null and let the caller fall back to the
      // finishReason heuristic. Never let a scan failure break generation.
    } finally {
      reader.releaseLock()
    }
  }

  return { fetch: wrapped, stopReason: () => stopReason, done }
}

export type GenerationOutcome =
  | { ok: true }
  | { ok: false; kind: 'context_overflow' | 'abnormal'; rawStopReason: string | null }

// Decide whether a *successful* (HTTP-200) streamed generation actually produced a
// complete, scoreable answer — or terminated abnormally and must be surfaced as an
// app-fault instead of being scored and persisted as a result.
//
//   • context_overflow: the provider's stop_reason is model_context_window_exceeded
//     (authoritative). The model may have emitted PARTIAL text first, so we MUST
//     NOT key off empty output — a truncated answer is still a fault.
//   • abnormal: we could not read a raw stop_reason (capture unavailable/failed)
//     but the SDK mapped the finish to "unknown" AND no usable text was produced.
//     We cannot prove a context overflow (could be a refusal/pause), so we reject
//     with generic copy rather than mis-advising the caller to shrink their input.
//   • ok: a normal finish, OR an unknown finish that still produced text (e.g. a
//     refusal) — a real, complete response that downstream scoring can handle.
export function classifyGenerationOutcome(args: {
  rawStopReason: string | null
  finishReason: string
  output: string
}): GenerationOutcome {
  if (args.rawStopReason === CONTEXT_OVERFLOW_STOP_REASON) {
    return { ok: false, kind: 'context_overflow', rawStopReason: args.rawStopReason }
  }
  if (args.finishReason === 'unknown' && args.output.trim() === '') {
    return { ok: false, kind: 'abnormal', rawStopReason: args.rawStopReason }
  }
  return { ok: true }
}
