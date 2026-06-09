'use client'

import { useCallback, useRef, useState } from 'react'
import type { RunMode, RunRequest } from '@/app/api/run/types'
import { getByoHeaders, getJudgeUsesByo } from '@/components/ApiKeyInput'
import { parseLine } from './useRun'

// ── The live-generation fan-out ──────────────────────────────────────────────
//
// This is the keystone the prototype faked: editing a prompt re-runs *generation*
// over N selected cases via N sequential POST /api/run calls (generate-only mode),
// streaming each output back as it arrives. Modeled on GoldenSetBuilder.runEval —
// that loop fans out /api/score; this one fans out /api/run generation.
//
// Sequential (not parallel) so the shared rate-limit bucket stops us cleanly at a
// known boundary instead of failing a burst. Abortable mid-run; rate-limit (429)
// stops gracefully with progress preserved; resumable (done cases are skipped).

const GEN_TIMEOUT_MS = 120_000 // matches /api/run maxDuration

export interface GenerationCase {
  id: string
  patientId: string
  query: string
  mode: RunMode
  /** Full record text — required for stuff mode. */
  record?: string
  /** Number of chunks to retrieve — retrieve mode only. */
  k?: number
}

export type CaseGenStatus = 'pending' | 'running' | 'done' | 'error'

export interface CaseGenResult {
  caseId: string
  status: CaseGenStatus
  output: string
  error?: string
}

export interface GenerationRunState {
  /** Per-case result keyed by case id. */
  results: Record<string, CaseGenResult>
  running: boolean
  /** True when a 429 stopped the run; remaining cases stay pending for resume. */
  rateLimited: boolean
  /** Number of cases that reached a terminal state (done or error). */
  completed: number
  /** Total cases in the most recent run/resume request. */
  total: number
  /** Case currently being generated, or null. */
  activeCaseId: string | null
}

const EMPTY_STATE: GenerationRunState = {
  results: {},
  running: false,
  rateLimited: false,
  completed: 0,
  total: 0,
  activeCaseId: null,
}

interface OneCaseOutcome {
  output: string
  rateLimited: boolean
  aborted: boolean
  error?: string
}

/**
 * Generate one case via POST /api/run in generate-only mode, accumulating the
 * streamed text. The per-case fetch is aborted by either the master signal
 * (user pressed Abort) or a wall-clock timeout.
 */
async function generateOneCase(
  c: GenerationCase,
  generationPrompt: string,
  masterSignal: AbortSignal,
  onToken: (partial: string) => void,
): Promise<OneCaseOutcome> {
  if (masterSignal.aborted) return { output: '', rateLimited: false, aborted: true }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  masterSignal.addEventListener('abort', onAbort)
  const timeoutId = setTimeout(() => controller.abort(), GEN_TIMEOUT_MS)

  try {
    const body: RunRequest & { generateOnly: boolean } = {
      patientId: c.patientId,
      query: c.query,
      mode: c.mode,
      record: c.mode === 'stuff' ? c.record : undefined,
      k: c.mode === 'retrieve' ? c.k : undefined,
      generationPrompt: generationPrompt || undefined,
      judgeUsesByo: getJudgeUsesByo(),
      generateOnly: true,
    }

    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getByoHeaders() },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (res.status === 429) return { output: '', rateLimited: true, aborted: false }
    if (!res.ok) {
      let msg = 'Request failed'
      try {
        const payload = (await res.json()) as { error?: string }
        msg = payload.error ?? msg
      } catch {
        /* non-JSON error body */
      }
      return { output: '', rateLimited: false, aborted: false, error: msg }
    }

    const reader = res.body?.getReader()
    if (!reader) return { output: '', rateLimited: false, aborted: false, error: 'No response body' }

    const decoder = new TextDecoder()
    let partial = ''
    let output = ''
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
          // generate-only mode emits no `eval` part; an `error` part is still possible
          // (e.g. over-context). retrieval/trace parts are ignored here.
          if (d.type === 'error') streamError = (d.message ?? 'Unknown error') as string
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

    return { output, rateLimited: false, aborted: false, error: streamError }
  } catch (e) {
    // An abort triggered by the master signal is a user action, not a case error.
    if (masterSignal.aborted) return { output: '', rateLimited: false, aborted: true }
    const msg = e instanceof Error ? e.message : 'Network error'
    return { output: '', rateLimited: false, aborted: false, error: msg }
  } finally {
    clearTimeout(timeoutId)
    masterSignal.removeEventListener('abort', onAbort)
  }
}

export function useGenerationRun() {
  const [state, setState] = useState<GenerationRunState>(EMPTY_STATE)

  // Source-of-truth refs so resume/abort read the latest values synchronously,
  // independent of React's async state batching.
  const resultsRef = useRef<Record<string, CaseGenResult>>({})
  const runningRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  const sync = useCallback((patch: Partial<GenerationRunState>) => {
    setState((s) => ({ ...s, results: { ...resultsRef.current }, ...patch }))
  }, [])

  const execute = useCallback(
    async (cases: GenerationCase[], generationPrompt: string, fresh: boolean) => {
      if (runningRef.current || cases.length === 0) return

      // Fresh run resets every case to pending; resume keeps prior `done` results.
      const prior = resultsRef.current
      const next: Record<string, CaseGenResult> = {}
      for (const c of cases) {
        next[c.id] =
          !fresh && prior[c.id]?.status === 'done'
            ? prior[c.id]
            : { caseId: c.id, status: 'pending', output: '' }
      }
      resultsRef.current = next

      runningRef.current = true
      const controller = new AbortController()
      abortRef.current = controller

      const total = cases.length
      let completed = Object.values(next).filter((r) => r.status === 'done' || r.status === 'error').length
      sync({ running: true, rateLimited: false, completed, total, activeCaseId: null })

      for (const c of cases) {
        if (controller.signal.aborted) break
        if (resultsRef.current[c.id]?.status === 'done') continue

        resultsRef.current[c.id] = { caseId: c.id, status: 'running', output: '' }
        sync({ activeCaseId: c.id })

        const outcome = await generateOneCase(c, generationPrompt, controller.signal, (partialOut) => {
          const cur = resultsRef.current[c.id]
          if (cur) {
            resultsRef.current[c.id] = { ...cur, output: partialOut }
            sync({})
          }
        })

        if (outcome.aborted) {
          // Leave this case pending so a later run/resume can pick it up.
          resultsRef.current[c.id] = { caseId: c.id, status: 'pending', output: '' }
          break
        }

        if (outcome.rateLimited) {
          // Stop gracefully — keep progress, mark rate-limited for resume.
          resultsRef.current[c.id] = { caseId: c.id, status: 'pending', output: '' }
          runningRef.current = false
          abortRef.current = null
          sync({ running: false, rateLimited: true, completed, total, activeCaseId: null })
          return
        }

        resultsRef.current[c.id] = {
          caseId: c.id,
          status: outcome.error ? 'error' : 'done',
          output: outcome.output,
          error: outcome.error,
        }
        completed++
        sync({ completed })
      }

      runningRef.current = false
      abortRef.current = null
      sync({ running: false, activeCaseId: null })
    },
    [sync],
  )

  /** Start fresh: every case is regenerated. */
  const run = useCallback(
    (cases: GenerationCase[], generationPrompt: string) => execute(cases, generationPrompt, true),
    [execute],
  )

  /** Continue after a rate-limit or abort: already-done cases are skipped. */
  const resume = useCallback(
    (cases: GenerationCase[], generationPrompt: string) => execute(cases, generationPrompt, false),
    [execute],
  )

  /** Stop the in-flight run; the active case returns to pending. */
  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    resultsRef.current = {}
    runningRef.current = false
    abortRef.current = null
    setState(EMPTY_STATE)
  }, [])

  return { ...state, run, resume, abort, reset }
}
