'use client'

import { useCallback, useState } from 'react'
import { genPromptHash } from '@/lib/cases'
import {
  createEmptyState,
  type NotebookEval,
  type NotebookRun,
  type NotebookState,
  type OutputStatus,
  type RunOutput,
  type ScoreRow,
} from '@/lib/notebook/state'
import pkg from '../../../package.json'
import type { OutputCardResult } from './useNotebookRun'

/**
 * useNotebookCube — the client-side assembly of the N4 (run × eval × patient)
 * bench-state cube from the notebook's live surface.
 *
 * This hook is the SINGLE owner of a `NotebookState`. The score line is a pure
 * PROJECTION of this object (see `lib/notebook/state.projectEvalTrail`) and Export
 * is `serializeState` of this WHOLE object — so the line the user sees and the
 * file they download are the same model viewed at different cardinalities, never
 * two structures that can drift.
 *
 * Two writes feed it:
 *   • `recordRun` — when a run finishes, snapshot its prompt + per-patient outputs
 *     into a run column (keyed by a stable string run id).
 *   • `recordScore` — when an eval is scored (golden Score / judge settle), write
 *     the rolled-up row into `scores[evalKey][runId]` and upsert the eval def.
 */

/** The producing app version — single-sourced from package.json, never a literal. */
export const APP_VERSION: string = pkg.version

/** A snapshot of one finished run, lifted from the live run-loop state. */
export interface RecordRunInput {
  /** Stable string run id (e.g. `run-3`); the cube's first axis. */
  runId: string
  /** Monotonic run version, for the "run N" column label. */
  version: number
  promptText: string
  /** Patient ids in submit order. */
  order: string[]
  results: Record<string, OutputCardResult>
  /** The active model id for this run (the fallback when a card lacks a stamp). */
  model: string
}

/** A minimal eval definition the cube upserts when a score row arrives. */
export interface EvalDefInput {
  /** `'golden'` or `'judge:<id>'`. */
  key: string
  label: string
  /** The golden answers or judge criteria the row was graded under. */
  criteriaOrGolden: string
}

/** Map a live card status to the cube's persisted output status. */
function toOutputStatus(r: OutputCardResult): OutputStatus {
  if (r.status === 'done') return r.output.trim().length > 0 ? 'ok' : 'empty'
  if (r.status === 'error') return 'error'
  return 'pending'
}

/** Build a cube run column from the live run-loop results. */
function buildRunOutputs(input: RecordRunInput): Record<string, RunOutput> {
  const outputs: Record<string, RunOutput> = {}
  for (const pid of input.order) {
    const r = input.results[pid]
    if (!r) continue
    outputs[pid] = {
      text: r.output,
      model: r.model ?? input.model,
      contextMode: r.context?.contextMode ?? 'full',
      sections: r.context?.sections.map((s) => s.section) ?? [],
      status: toOutputStatus(r),
    }
  }
  return outputs
}

/** Union the model ids in play across every run output (meta.modelIds). */
function collectModelIds(runs: NotebookRun[]): string[] {
  const seen = new Set<string>()
  for (const run of runs) {
    for (const out of Object.values(run.outputs)) seen.add(out.model)
  }
  return [...seen]
}

export function useNotebookCube() {
  const [state, setState] = useState<NotebookState>(() =>
    createEmptyState({ appVersion: APP_VERSION }),
  )

  const recordRun = useCallback((input: RecordRunInput) => {
    const outputs = buildRunOutputs(input)
    if (Object.keys(outputs).length === 0) return
    setState((prev) => {
      const entry: NotebookRun = {
        id: input.runId,
        version: input.version,
        promptText: input.promptText,
        promptHash: genPromptHash(input.promptText),
        // A wall-clock stamp is fine here (app runtime, not a workflow script).
        createdAt: new Date().toISOString(),
        outputs,
      }
      const idx = prev.runs.findIndex((r) => r.id === input.runId)
      const runs =
        idx === -1
          ? [...prev.runs, entry]
          : prev.runs.map((r, i) => (i === idx ? entry : r))
      return { ...prev, runs, meta: { ...prev.meta, modelIds: collectModelIds(runs) } }
    })
  }, [])

  // Remove an eval entirely from the cube — its score column AND its definition.
  // Fired when a judge cell is removed (N14): a removed judge leaves no trace in
  // state, so the score line stops projecting its row and an export never carries
  // a judge the user deleted. The GOLDEN eval is singular and never removed here.
  const removeScore = useCallback((evalKey: string) => {
    setState((prev) => {
      const hasScore = Boolean(prev.scores[evalKey])
      const hasDef = prev.evals.some((e) => e.key === evalKey)
      if (!hasScore && !hasDef) return prev
      const scores = { ...prev.scores }
      delete scores[evalKey]
      const evals = prev.evals.filter((e) => e.key !== evalKey)
      return { ...prev, evals, scores }
    })
  }, [])

  const recordScore = useCallback((runId: string, def: EvalDefInput, row: ScoreRow) => {
    setState((prev) => {
      // Upsert the eval definition (one version per notebook eval).
      const contentHash = genPromptHash(def.criteriaOrGolden)
      const existing = prev.evals.find((e) => e.key === def.key)
      const evalDef: NotebookEval = existing
        ? { ...existing, label: def.label, criteriaOrGolden: def.criteriaOrGolden }
        : {
            key: def.key,
            label: def.label,
            version: 1,
            criteriaOrGolden: def.criteriaOrGolden,
            history: [{ version: 1, contentHash }],
          }
      const evals = existing
        ? prev.evals.map((e) => (e.key === def.key ? evalDef : e))
        : [...prev.evals, evalDef]

      // Write the cell into scores[evalKey][runId].
      const scores = {
        ...prev.scores,
        [def.key]: { ...(prev.scores[def.key] ?? {}), [runId]: row },
      }
      return { ...prev, evals, scores }
    })
  }, [])

  return { state, recordRun, recordScore, removeScore }
}
