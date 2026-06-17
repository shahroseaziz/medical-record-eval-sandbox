'use client'

import { useCallback, useRef, useState } from 'react'
import type { RunRequest } from '@/app/api/run/types'
import { parseLine } from '@/hooks/useRun'
import { BYO_KEY_HEADER } from '@/lib/redact'
import type { ContextManifest, ContextSection } from '@/lib/run/context-manifest'

// ── Notebook run loop ────────────────────────────────────────────────────────
//
// N8a: author ONE prompt, pick patients, hit Run → fan out a POST /api/run per
// selected patient and stream each output back as it arrives. Modeled on the
// established live-generation fan-out (src/hooks/useGenerationRun) but kept
// self-contained for the notebook for two reasons:
//   • the notebook holds its BYO key under its own sessionStorage key
//     (`mres.nb.byokey`), so the key + active model are threaded in explicitly
//     rather than read from the bench's separate `byo_api_key` slot, and
//   • each card must stamp the PRODUCING model id, which we read off the streamed
//     trace frame (`trace.generationModel`) — the id travels in the response and
//     is never written as a literal in the component (rule 13 single-source).
//
// Sequential (not parallel): the shared free-tier rate-limit bucket stops a free
// run cleanly at a known boundary instead of failing a burst. generate-only mode
// streams generation without paying the faithfulness judge — the eval/score cells
// are separate, later steps.

const RUN_TIMEOUT_MS = 120_000 // matches /api/run maxDuration

/** One patient to run the prompt against. The record is the stuff-mode grounding. */
export interface NotebookRunCase {
  patientId: string
  /** Full assembled stuff-mode record (from /api/patients/sample). */
  record: string
}

export type CardStatus = 'pending' | 'streaming' | 'done' | 'error'

/** One output card's live state. */
export interface OutputCardResult {
  patientId: string
  status: CardStatus
  output: string
  /**
   * The producing model id, captured from the streamed trace frame
   * (`trace.generationModel`). Null until the trace arrives; the component reads
   * THIS rather than any local literal so the stamp cannot drift from lib/models.
   */
  model: string | null
  /**
   * The "what the model saw" receipt — the `type:'context'` manifest emitted by
   * /api/run (N2) BEFORE generation, describing the grounding the model received:
   * the context mode (full/retrieved), the sections sent, and (retrieve mode) any
   * sections dropped for budget. Null until the context frame arrives. The card
   * renders ONLY what this carries — no fabricated context.
   */
  context: ContextManifest | null
  error?: string
}

export interface NotebookRunState {
  /** Per-patient card result, keyed by patient id. */
  results: Record<string, OutputCardResult>
  running: boolean
  /** Bumped on every fresh run so cards can reset their stream animation. */
  runId: number
  /** Patient currently generating, or null. */
  activePatientId: string | null
}

const EMPTY_STATE: NotebookRunState = {
  results: {},
  running: false,
  runId: 0,
  activePatientId: null,
}

/** Options carrying the notebook's active model + BYO key into the run. */
export interface NotebookRunOptions {
  /**
   * Generation model id — the notebook's ACTIVE model (free GENERATION_MODEL or
   * BYO_MODEL). Passed in from lib/models via the shell, never a literal here, so
   * the server records and echoes back the model the user actually selected.
   */
  model: string
  /** BYO Anthropic key, sent in-flight as the BYO_KEY_HEADER. Never logged. */
  byoKey?: string
}

interface OneCaseOutcome {
  output: string
  model: string | null
  context: ContextManifest | null
  error?: string
  aborted: boolean
}

/**
 * Generate one patient via POST /api/run in generate-only stuff mode, accumulating
 * streamed tokens and capturing the producing model id from the trace frame.
 */
async function runOneCase(
  c: NotebookRunCase,
  prompt: string,
  opts: NotebookRunOptions,
  masterSignal: AbortSignal,
  onToken: (partial: string) => void,
): Promise<OneCaseOutcome> {
  if (masterSignal.aborted) return { output: '', model: null, context: null, aborted: true }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  masterSignal.addEventListener('abort', onAbort)
  const timeoutId = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS)

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    // BYO key is sent per-request as an HTTPS header, never in the body or URL.
    if (opts.byoKey) headers[BYO_KEY_HEADER] = opts.byoKey

    // The single notebook prompt is the QUESTION asked of each chart; the built-in
    // analyst system prompt stays in place (there is deliberately no system-prompt
    // editor). generateOnly skips the judge — generation only for this cell.
    const body: RunRequest = {
      patientId: c.patientId,
      query: prompt,
      mode: 'stuff',
      record: c.record,
      model: opts.model,
      generateOnly: true,
    }

    const res = await fetch('/api/run', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!res.ok) {
      let msg =
        res.status === 429
          ? 'Free-tier limit reached. Add your own key to keep running.'
          : 'Request failed.'
      try {
        const payload = (await res.json()) as { error?: string }
        if (payload.error) msg = payload.error
      } catch {
        /* non-JSON error body */
      }
      return { output: '', model: null, context: null, error: msg, aborted: false }
    }

    const reader = res.body?.getReader()
    if (!reader) return { output: '', model: null, context: null, error: 'No response body', aborted: false }

    const decoder = new TextDecoder()
    let partial = ''
    let output = ''
    let model: string | null = null
    let context: ContextManifest | null = null
    let streamError: string | undefined

    const processLine = (line: string) => {
      const parsed = parseLine(line)
      if (!parsed) return
      if (parsed.kind === 'text') {
        output += parsed.value
        onToken(output)
      } else if (parsed.kind === 'err') {
        streamError = parsed.message
      } else if (parsed.kind === 'data') {
        for (const item of parsed.items) {
          const d = item as Record<string, unknown>
          // The trace frame carries the producing model id (generationModel),
          // sourced server-side from lib/models. This is the card's model stamp.
          if (d.type === 'trace') {
            const trace = d.trace as { generationModel?: string } | undefined
            if (trace?.generationModel) model = trace.generationModel
          } else if (d.type === 'context') {
            // The "what the model saw" receipt (N2). We keep ONLY the manifest
            // fields — contextMode / sections / droppedSections — discarding the
            // retrieve-mode chunk detail the workbench surface uses. The card
            // renders exactly what arrives here; nothing is fabricated.
            const mode = d.contextMode
            if (mode === 'full' || mode === 'retrieved') {
              const sections = Array.isArray(d.sections) ? (d.sections as ContextSection[]) : []
              const dropped = Array.isArray(d.droppedSections)
                ? (d.droppedSections as string[])
                : []
              context = {
                contextMode: mode,
                sections,
                ...(dropped.length > 0 ? { droppedSections: dropped } : {}),
              }
            }
          } else if (d.type === 'error') {
            streamError = (d.message ?? 'Unknown error') as string
          }
        }
      }
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    }
    if (partial) processLine(partial)

    return { output, model, context, error: streamError, aborted: false }
  } catch (e) {
    if (masterSignal.aborted) return { output: '', model: null, context: null, aborted: true }
    const msg = e instanceof Error ? e.message : 'Network error'
    return { output: '', model: null, context: null, error: msg, aborted: false }
  } finally {
    clearTimeout(timeoutId)
    masterSignal.removeEventListener('abort', onAbort)
  }
}

export function useNotebookRun() {
  const [state, setState] = useState<NotebookRunState>(EMPTY_STATE)

  // Source-of-truth refs so the loop reads the latest values synchronously,
  // independent of React's async state batching.
  const resultsRef = useRef<Record<string, OutputCardResult>>({})
  const runningRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)

  const sync = useCallback((patch: Partial<NotebookRunState>) => {
    setState((s) => ({ ...s, results: { ...resultsRef.current }, ...patch }))
  }, [])

  const run = useCallback(
    async (cases: NotebookRunCase[], prompt: string, opts: NotebookRunOptions) => {
      if (runningRef.current || cases.length === 0) return

      const next: Record<string, OutputCardResult> = {}
      for (const c of cases) {
        next[c.patientId] = {
          patientId: c.patientId,
          status: 'pending',
          output: '',
          model: null,
          context: null,
        }
      }
      resultsRef.current = next

      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      runIdRef.current += 1
      sync({ running: true, runId: runIdRef.current, activePatientId: null })

      for (const c of cases) {
        if (controller.signal.aborted) break

        resultsRef.current[c.patientId] = {
          patientId: c.patientId,
          status: 'streaming',
          output: '',
          model: null,
          context: null,
        }
        sync({ activePatientId: c.patientId })

        const outcome = await runOneCase(c, prompt, opts, controller.signal, (partialOut) => {
          const cur = resultsRef.current[c.patientId]
          if (cur) {
            resultsRef.current[c.patientId] = { ...cur, output: partialOut }
            sync({})
          }
        })

        if (outcome.aborted) {
          resultsRef.current[c.patientId] = {
            patientId: c.patientId,
            status: 'pending',
            output: '',
            model: null,
            context: null,
          }
          break
        }

        resultsRef.current[c.patientId] = {
          patientId: c.patientId,
          status: outcome.error ? 'error' : 'done',
          output: outcome.output,
          model: outcome.model,
          context: outcome.context,
          error: outcome.error,
        }
        sync({})
      }

      runningRef.current = false
      abortRef.current = null
      sync({ running: false, activePatientId: null })
    },
    [sync],
  )

  /** Stop the in-flight run; the active card returns to pending. */
  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { ...state, run, abort }
}
