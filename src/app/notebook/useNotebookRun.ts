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

// 'rate-limited' is a REAL engine state, not a simulated toggle: it is set ONLY
// when /api/run returns the Upstash limiter's 429 (X-RateLimit-* headers present).
// It is per-patient and resumable. The daily kill-switch (spend cap) is a separate,
// session-level signal surfaced via NotebookRunState.spendCapped — never a card status.
export type CardStatus = 'pending' | 'streaming' | 'done' | 'error' | 'rate-limited'

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
  /**
   * Set when /api/run returns the REAL daily kill-switch 429 (the spend cap: a
   * 429 with NO X-RateLimit-* headers, body "Free-tier usage limit reached…").
   * Session-level, not per-patient — the prompt + selected patients are preserved
   * untouched and the shell offers the BYO "Add your key" path. Cleared on the
   * next fresh run.
   */
  spendCapped: boolean
}

const EMPTY_STATE: NotebookRunState = {
  results: {},
  running: false,
  runId: 0,
  activePatientId: null,
  spendCapped: false,
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

/**
 * The two REAL 429s /api/run can return — kept DISTINCT, never conflated:
 *   • 'rate-limit' — the Upstash limiter (always carries X-RateLimit-* headers).
 *     Per-patient and resumable; nothing was charged.
 *   • 'spend-cap'  — the daily kill-switch (no rate-limit headers). Session-level;
 *     drives the BYO "Add your key" path with the prompt + patients preserved.
 */
export type RunFailureKind = 'rate-limit' | 'spend-cap'

interface OneCaseOutcome {
  output: string
  model: string | null
  context: ContextManifest | null
  error?: string
  /** Set only for the two classified 429s; undefined for ordinary errors. */
  failureKind?: RunFailureKind
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
      // Two REAL 429s arrive from /api/run and must NOT be conflated. We key on the
      // STRUCTURAL signal — the Upstash limiter always sets X-RateLimit-* headers,
      // the daily kill-switch never does — corroborated by the verbatim body text:
      //   • rate-limit: "Rate limit exceeded…" + X-RateLimit-* headers → per-patient,
      //     resumable, nothing charged.
      //   • spend-cap:  "Free-tier usage limit reached…" (no RL headers) → session-
      //     level → the BYO "Add your key" path; the prompt + patients are preserved.
      const hasRlHeaders =
        res.headers.has('X-RateLimit-Limit') || res.headers.has('X-RateLimit-Reset')
      let bodyError: string | undefined
      try {
        const payload = (await res.json()) as { error?: string }
        if (payload.error) bodyError = payload.error
      } catch {
        /* non-JSON error body */
      }
      if (res.status === 429) {
        if (hasRlHeaders) {
          return {
            output: '',
            model: null,
            context: null,
            failureKind: 'rate-limit',
            error: bodyError ?? 'Rate limit exceeded.',
            aborted: false,
          }
        }
        return {
          output: '',
          model: null,
          context: null,
          failureKind: 'spend-cap',
          error: bodyError ?? 'Free-tier usage limit reached.',
          aborted: false,
        }
      }
      return {
        output: '',
        model: null,
        context: null,
        error: bodyError ?? 'Request failed.',
        aborted: false,
      }
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

/** A fresh pending card for a patient (the un-run, nothing-charged state). */
function pendingCard(patientId: string): OutputCardResult {
  return { patientId, status: 'pending', output: '', model: null, context: null }
}

export function useNotebookRun() {
  const [state, setState] = useState<NotebookRunState>(EMPTY_STATE)

  // Source-of-truth refs so the loop reads the latest values synchronously,
  // independent of React's async state batching.
  const resultsRef = useRef<Record<string, OutputCardResult>>({})
  const runningRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const runIdRef = useRef(0)
  // Captured at run time so a per-patient Resume can re-run a single case with the
  // exact prompt that produced this run (a later prompt edit is a separate re-run,
  // not a resume) while picking up the CURRENT key/model.
  const casesRef = useRef<NotebookRunCase[]>([])
  const promptRef = useRef('')
  const optsRef = useRef<NotebookRunOptions>({ model: '' })

  const sync = useCallback((patch: Partial<NotebookRunState>) => {
    setState((s) => ({ ...s, results: { ...resultsRef.current }, ...patch }))
  }, [])

  // Run ONE case through /api/run and apply its outcome to that card. Shared by the
  // fan-out loop and per-patient Resume so both classify the REAL signals
  // identically. Returns the terminal disposition the caller acts on.
  const runCase = useCallback(
    async (c: NotebookRunCase, signal: AbortSignal): Promise<'ok' | 'aborted' | 'spend-cap'> => {
      resultsRef.current[c.patientId] = {
        patientId: c.patientId,
        status: 'streaming',
        output: '',
        model: null,
        context: null,
      }
      sync({ activePatientId: c.patientId })

      const outcome = await runOneCase(c, promptRef.current, optsRef.current, signal, (partialOut) => {
        const cur = resultsRef.current[c.patientId]
        if (cur) {
          resultsRef.current[c.patientId] = { ...cur, output: partialOut }
          sync({})
        }
      })

      if (outcome.aborted) {
        resultsRef.current[c.patientId] = pendingCard(c.patientId)
        return 'aborted'
      }

      // Daily kill-switch: nothing ran for this patient and nothing was charged.
      // Return the card to pending (its output is PRESERVED as un-run) and signal
      // the session-level cap up to the loop/resume caller.
      if (outcome.failureKind === 'spend-cap') {
        resultsRef.current[c.patientId] = pendingCard(c.patientId)
        return 'spend-cap'
      }

      // Limiter 429: a real, per-patient, resumable state. Nothing was charged.
      if (outcome.failureKind === 'rate-limit') {
        resultsRef.current[c.patientId] = {
          patientId: c.patientId,
          status: 'rate-limited',
          output: '',
          model: null,
          context: null,
          error: outcome.error,
        }
        sync({})
        return 'ok'
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
      return 'ok'
    },
    [sync],
  )

  const run = useCallback(
    async (cases: NotebookRunCase[], prompt: string, opts: NotebookRunOptions) => {
      if (runningRef.current || cases.length === 0) return

      const next: Record<string, OutputCardResult> = {}
      for (const c of cases) next[c.patientId] = pendingCard(c.patientId)
      resultsRef.current = next
      casesRef.current = cases
      promptRef.current = prompt
      optsRef.current = opts

      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      runIdRef.current += 1
      // A fresh run clears any prior spend-cap state.
      sync({ running: true, runId: runIdRef.current, activePatientId: null, spendCapped: false })

      for (const c of cases) {
        if (controller.signal.aborted) break
        const disposition = await runCase(c, controller.signal)
        if (disposition === 'aborted') break
        if (disposition === 'spend-cap') {
          // Stop the fan-out: the cap is session-level. Remaining patients stay
          // pending (preserved) and the shell paints the BYO path.
          sync({ spendCapped: true })
          break
        }
      }

      runningRef.current = false
      abortRef.current = null
      sync({ running: false, activePatientId: null })
    },
    [sync, runCase],
  )

  /**
   * Re-run a SINGLE patient (per-patient Resume after a rate-limit). Uses the run's
   * captured prompt so the resumed card matches its siblings, but takes fresh opts
   * (current key/model) when provided — e.g. the user added a key to get past the
   * shared limit.
   */
  const resume = useCallback(
    async (patientId: string, opts?: NotebookRunOptions) => {
      if (runningRef.current) return
      const c = casesRef.current.find((x) => x.patientId === patientId)
      if (!c) return
      if (opts) optsRef.current = opts

      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      sync({ running: true, activePatientId: patientId })

      const disposition = await runCase(c, controller.signal)
      if (disposition === 'spend-cap') sync({ spendCapped: true })

      runningRef.current = false
      abortRef.current = null
      sync({ running: false, activePatientId: null })
    },
    [sync, runCase],
  )

  /** Stop the in-flight run; the active card returns to pending. */
  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { ...state, run, resume, abort }
}
