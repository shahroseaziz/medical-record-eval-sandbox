'use client'

import { useCallback, useRef, useState } from 'react'
import { BYO_KEY_HEADER } from '@/lib/redact'
import { JUDGE_MODEL } from '@/lib/models'

// ── Notebook LLM-judge loop (SHA-162 N10) ────────────────────────────────────
//
// The judge eval layer: a single-call criteria verdict per patient. For each
// patient we POST the documented criteria-verdict contract to /api/score
// (`{source:'criteria', criteria, patientId, output}` → `{pass, reason}`) and
// render the verdict. There is EXACTLY ONE metered call per patient — the
// two-call faithfulness pipeline (extract → verdict) is NOT exposed here; it
// lives in the engine + CI only. This loop only ever touches the single-call
// `source:'criteria'` branch.
//
// Sequential (not parallel), mirroring the generation run loop: the shared
// free-tier rate-limit bucket stops a free judge run cleanly at a known boundary
// instead of failing a burst.
//
// The producing model id stamped on each verdict is JUDGE_MODEL, imported from
// lib/models (the single id source, rule 13) — the criteria judge always runs on
// JUDGE_MODEL regardless of the BYO key, so the stamp cannot drift from a literal.

const JUDGE_TIMEOUT_MS = 60_000 // matches /api/score maxDuration

/** One patient to judge: its id + the model output the verdict is rendered against. */
export interface JudgeCase {
  patientId: string
  output: string
}

export type JudgeStatus = 'pending' | 'judging' | 'done' | 'errored'

/** One patient's judge verdict state. */
export interface JudgeVerdict {
  patientId: string
  status: JudgeStatus
  /** The binary verdict (DECISION D1: no "partial" state). Null until done / on error. */
  pass: boolean | null
  /**
   * The judge's one-paragraph reason. Null until done. NEVER fabricated on error —
   * a judge failure leaves this null and surfaces `error` instead, so the UI shows
   * the "couldn't grade" copy rather than inventing a rationale.
   */
  reason: string | null
  /**
   * The producing judge model id (JUDGE_MODEL). Stamped on every settled verdict,
   * pass OR fail, from lib/models — never a local literal.
   */
  model: string | null
  /** Present only when the judge call failed for this patient. */
  error?: string
}

export interface NotebookJudgeState {
  /** Per-patient verdict, keyed by patient id. */
  verdicts: Record<string, JudgeVerdict>
  judging: boolean
  /** Bumped on every fresh judge run. */
  judgeRunId: number
}

const EMPTY_STATE: NotebookJudgeState = {
  verdicts: {},
  judging: false,
  judgeRunId: 0,
}

export interface NotebookJudgeOptions {
  /** BYO Anthropic key, forwarded in-flight as the BYO_KEY_HEADER. Never logged. */
  byoKey?: string
}

interface OneVerdictOutcome {
  pass: boolean | null
  reason: string | null
  error?: string
  aborted: boolean
}

/**
 * Judge ONE patient via POST /api/score against the single-call criteria-verdict
 * contract. Exactly one metered call: the request always carries `source:'criteria'`,
 * so the route's faithfulness paths are never reached.
 */
async function judgeOneCase(
  c: JudgeCase,
  criteria: string,
  opts: NotebookJudgeOptions,
  masterSignal: AbortSignal,
): Promise<OneVerdictOutcome> {
  if (masterSignal.aborted) return { pass: null, reason: null, aborted: true }

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  masterSignal.addEventListener('abort', onAbort)
  const timeoutId = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS)

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (opts.byoKey) headers[BYO_KEY_HEADER] = opts.byoKey

    const res = await fetch('/api/score', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: 'criteria',
        criteria,
        patientId: c.patientId,
        output: c.output,
      }),
      signal: controller.signal,
    })

    if (!res.ok) {
      let msg =
        res.status === 429
          ? 'Free-tier limit reached. Add your own key to keep judging.'
          : 'The judge call failed for this patient.'
      try {
        const payload = (await res.json()) as { error?: string }
        if (payload.error) msg = payload.error
      } catch {
        /* non-JSON error body */
      }
      // No fabricated verdict on error: pass + reason stay null.
      return { pass: null, reason: null, error: msg, aborted: false }
    }

    const payload = (await res.json()) as { pass?: unknown; reason?: unknown }
    // Defensive: the contract is {pass:boolean, reason:string}. A malformed body is
    // treated as a judge failure rather than coerced into a verdict.
    if (typeof payload.pass !== 'boolean' || typeof payload.reason !== 'string') {
      return { pass: null, reason: null, error: 'The judge returned an unreadable verdict.', aborted: false }
    }
    return { pass: payload.pass, reason: payload.reason, aborted: false }
  } catch (e) {
    if (masterSignal.aborted) return { pass: null, reason: null, aborted: true }
    const msg = e instanceof Error ? e.message : 'Network error'
    return { pass: null, reason: null, error: msg, aborted: false }
  } finally {
    clearTimeout(timeoutId)
    masterSignal.removeEventListener('abort', onAbort)
  }
}

export function useNotebookJudge() {
  const [state, setState] = useState<NotebookJudgeState>(EMPTY_STATE)

  const verdictsRef = useRef<Record<string, JudgeVerdict>>({})
  const judgingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const judgeRunIdRef = useRef(0)

  const sync = useCallback((patch: Partial<NotebookJudgeState>) => {
    setState((s) => ({ ...s, verdicts: { ...verdictsRef.current }, ...patch }))
  }, [])

  const runJudge = useCallback(
    async (cases: JudgeCase[], criteria: string, opts: NotebookJudgeOptions) => {
      if (judgingRef.current || cases.length === 0 || !criteria.trim()) return

      const next: Record<string, JudgeVerdict> = {}
      for (const c of cases) {
        next[c.patientId] = {
          patientId: c.patientId,
          status: 'pending',
          pass: null,
          reason: null,
          model: null,
        }
      }
      verdictsRef.current = next

      judgingRef.current = true
      const controller = new AbortController()
      abortRef.current = controller
      judgeRunIdRef.current += 1
      sync({ judging: true, judgeRunId: judgeRunIdRef.current })

      // One metered call per patient, sequentially.
      for (const c of cases) {
        if (controller.signal.aborted) break

        verdictsRef.current[c.patientId] = {
          patientId: c.patientId,
          status: 'judging',
          pass: null,
          reason: null,
          model: null,
        }
        sync({})

        const outcome = await judgeOneCase(c, criteria, opts, controller.signal)
        if (outcome.aborted) {
          verdictsRef.current[c.patientId] = {
            patientId: c.patientId,
            status: 'pending',
            pass: null,
            reason: null,
            model: null,
          }
          break
        }

        verdictsRef.current[c.patientId] = {
          patientId: c.patientId,
          status: outcome.error ? 'errored' : 'done',
          pass: outcome.pass,
          // Reason is left null on error — never fabricated.
          reason: outcome.reason,
          // Stamp the producing judge model id on every settled verdict.
          model: JUDGE_MODEL,
          error: outcome.error,
        }
        sync({})
      }

      judgingRef.current = false
      abortRef.current = null
      sync({ judging: false })
    },
    [sync],
  )

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return { ...state, runJudge, abort }
}
