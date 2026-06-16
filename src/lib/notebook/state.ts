// ── Notebook bench-state v1 ──────────────────────────────────────────────────
//
// N4 — the client-side state model for the new notebook. Keyed (run, eval,
// patient) from day one, so the simple score line and the later grid are the
// SAME object: the simple trail is a PROJECTION of one row of `scores`, never a
// separate field (see `projectSimpleTrail` below).
//
// Storage lives under the new namespace `mres.nb.v1`. We do NOT migrate the old
// `bench.*` or pivot keys — this is a fresh model, and a versioned zod schema
// gates every import: a malformed payload is REJECTED with a message and loads
// NOTHING (no partial load), so the surface never paints half-validated state.
//
// This module is pure (plus thin, guarded localStorage wrappers); no UI.

import { z } from 'zod'

/** localStorage namespace for the notebook. Bumped with the schema version. */
export const STORAGE_KEY = 'mres.nb.v1'

/** The schema version literal stamped into every export and checked on import. */
export const SCHEMA_VERSION = 'mres.nb.v1'

// ── Leaf schemas ─────────────────────────────────────────────────────────────

/** The retrieval posture a run's output was produced under. */
export const CONTEXT_MODES = ['full', 'retrieved'] as const
const ContextModeSchema = z.enum(CONTEXT_MODES)

/** Status of a single per-patient output within a run. */
export const OUTPUT_STATUSES = ['pending', 'ok', 'error', 'empty'] as const
const OutputStatusSchema = z.enum(OUTPUT_STATUSES)

/**
 * One patient's generated output inside a run. Carries either structured `json`
 * or free `text` (the model may emit either), plus the provenance the grid needs
 * to explain a cell: which model, which context posture, which sections fed it.
 */
const RunOutputSchema = z.object({
  json: z.unknown().optional(),
  text: z.string().optional(),
  model: z.string(),
  contextMode: ContextModeSchema,
  sections: z.array(z.string()),
  status: OutputStatusSchema,
})

/**
 * A single run: one prompt (text + hash for de-dup/identity) generated against a
 * set of patients. `outputs` is keyed by patientId — the second axis of the
 * (run, eval, patient) cube.
 */
const RunSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  promptText: z.string(),
  promptHash: z.string(),
  createdAt: z.string(),
  outputs: z.record(z.string(), RunOutputSchema),
})

// An eval key is the canonical golden set, or a specific judge: `judge:<id>`.
const EVAL_KEY_RE = /^judge:[A-Za-z0-9_.-]+$/
const EvalKeySchema = z
  .string()
  .refine((k) => k === 'golden' || EVAL_KEY_RE.test(k), {
    message: 'evalKey must be "golden" or "judge:<id>"',
  })

/**
 * An eval definition: a golden set or a judge, with a version trail. `history`
 * records each (version, contentHash) so a score row can be tied back to the
 * exact criteria/golden it was graded under.
 */
const EvalSchema = z.object({
  key: EvalKeySchema,
  label: z.string(),
  version: z.number().int().nonnegative(),
  criteriaOrGolden: z.string(),
  history: z.array(
    z.object({
      version: z.number().int().nonnegative(),
      contentHash: z.string(),
    }),
  ),
})

/**
 * Per-patient score within one (eval, run) row. `pass` is the golden-row signal;
 * `state` is the judge-row signal. `agree` lives ONLY on judge-row entries — it is
 * the sole source for the later disputed-cell indicator and the "you: a/m" marker.
 */
const PerCaseScoreSchema = z.object({
  patientId: z.string(),
  pass: z.boolean().optional(),
  state: z.string().optional(),
  fails: z.array(z.string()),
  reason: z.string().optional(),
  errored: z.boolean().optional(),
  agree: z.enum(['a', 'm']).optional(),
})

/**
 * One row of `scores`: a single (eval, run) cell-column. `frac` is the rolled-up
 * "n/m" string and `per` is the per-patient breakdown. THIS is the simple-trail
 * shape — the simple score line is exactly one of these rows.
 */
const ScoreRowSchema = z.object({
  frac: z.string(),
  per: z.array(PerCaseScoreSchema),
})

/** scores[evalKey][runId] → ScoreRow. (run, eval, patient) is the load-bearing key. */
const ScoresSchema = z.record(z.string(), z.record(z.string(), ScoreRowSchema))

/** Export envelope meta: the model ids in play and the producing app version. */
const MetaSchema = z.object({
  modelIds: z.array(z.string()),
  appVersion: z.string(),
})

// ── Top-level state / export schema ──────────────────────────────────────────

/**
 * The full notebook state — and the export envelope. Export = this whole object
 * (the cube + meta). Import validates against this versioned schema and rejects
 * on any mismatch; `schemaVersion` is a literal so a stale/foreign payload fails
 * fast rather than partially loading.
 */
export const NotebookStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  runs: z.array(RunSchema),
  evals: z.array(EvalSchema),
  scores: ScoresSchema,
  meta: MetaSchema,
})

export type ContextMode = (typeof CONTEXT_MODES)[number]
export type OutputStatus = (typeof OUTPUT_STATUSES)[number]
export type RunOutput = z.infer<typeof RunOutputSchema>
export type NotebookRun = z.infer<typeof RunSchema>
export type NotebookEval = z.infer<typeof EvalSchema>
export type PerCaseScore = z.infer<typeof PerCaseScoreSchema>
export type ScoreRow = z.infer<typeof ScoreRowSchema>
export type NotebookMeta = z.infer<typeof MetaSchema>
export type NotebookState = z.infer<typeof NotebookStateSchema>

// ── Construction ─────────────────────────────────────────────────────────────

/** An empty, valid notebook state — the cold-start surface. */
export function createEmptyState(meta?: Partial<NotebookMeta>): NotebookState {
  return {
    schemaVersion: SCHEMA_VERSION,
    runs: [],
    evals: [],
    scores: {},
    meta: { modelIds: meta?.modelIds ?? [], appVersion: meta?.appVersion ?? '' },
  }
}

// ── Export / import (zod-gated I/O) ──────────────────────────────────────────

/** Serialize the full state (cube + meta) to the export string. */
export function serializeState(state: NotebookState): string {
  return JSON.stringify(state)
}

/** The result of a non-throwing import attempt. */
export type ImportResult =
  | { ok: true; state: NotebookState }
  | { ok: false; error: string }

/**
 * Validate a candidate payload (string or parsed object) against the versioned
 * schema. Returns the validated state or an error — never a partial object. This
 * is the safe entry point; `importState` wraps it and throws.
 */
export function safeImportState(input: string | unknown): ImportResult {
  let candidate: unknown = input
  if (typeof input === 'string') {
    try {
      candidate = JSON.parse(input)
    } catch (e) {
      return { ok: false, error: `Invalid JSON: ${(e as Error).message}` }
    }
  }
  const parsed = NotebookStateSchema.safeParse(candidate)
  if (!parsed.success) {
    return { ok: false, error: `Notebook import rejected: ${parsed.error.message}` }
  }
  return { ok: true, state: parsed.data }
}

/**
 * Import a payload, throwing on any mismatch. Loads NOTHING on failure — the
 * caller's state is left untouched because this returns a value or throws; it
 * never mutates in place.
 */
export function importState(input: string | unknown): NotebookState {
  const result = safeImportState(input)
  if (!result.ok) throw new Error(result.error)
  return result.state
}

// ── localStorage wrappers (thin, guarded) ───────────────────────────────────

/** Persist state under the notebook namespace. No-op when storage is absent. */
export function saveState(state: NotebookState): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, serializeState(state))
}

/**
 * Load state from the notebook namespace. Returns null when nothing is stored or
 * storage is absent; rejects (returns null via the import gate) a corrupt blob
 * rather than partially loading.
 */
export function loadState(): NotebookState | null {
  if (typeof localStorage === 'undefined') return null
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw == null) return null
  const result = safeImportState(raw)
  return result.ok ? result.state : null
}

// ── Projection: the simple score trail ───────────────────────────────────────

/**
 * The simple score trail — the shape behind the simple score line. It is exactly
 * one row of `scores`, so the trail and the later grid are the SAME object viewed
 * at different cardinalities; the trail is never stored separately.
 */
export type SimpleTrail = ScoreRow

/**
 * Project a single (eval, run) cell-column out of the cube — the simple trail.
 * Returns undefined when that cell does not exist. For a 1×1 state (one eval, one
 * run) this is the whole `scores` content, which is why the simple line and the
 * grid never diverge: one is a projection of the other.
 */
export function projectSimpleTrail(
  state: NotebookState,
  evalKey: string,
  runId: string,
): SimpleTrail | undefined {
  return state.scores[evalKey]?.[runId]
}

/**
 * Convenience for the common 1×1 case: project the trail for the state's only
 * eval and only run. Returns undefined unless the state holds exactly one eval
 * with exactly one scored run.
 */
export function projectOnlyTrail(state: NotebookState): SimpleTrail | undefined {
  const evalKeys = Object.keys(state.scores)
  if (evalKeys.length !== 1) return undefined
  const runs = state.scores[evalKeys[0]]
  const runIds = Object.keys(runs)
  if (runIds.length !== 1) return undefined
  return runs[runIds[0]]
}
