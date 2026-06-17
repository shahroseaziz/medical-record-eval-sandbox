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
import { genPromptHash } from '@/lib/cases'

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
  // The eval VERSION this row was graded under, stamped at scoring time. Rows are
  // immutable once written, so a later version bump never rewrites this — that is
  // how the (run, eval@version) association survives without a runId in history.
  // Optional so pre-versioning exports still validate; new writes always stamp it.
  evalVersion: z.number().int().positive().optional(),
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

// ── Eval versioning (content hash → version) ─────────────────────────────────
//
// An eval's VERSION is a content-hash trail. Both judges (criteria text) and the
// golden (its JSON set) are versioned — the reference can be wrong for the same
// reason a judge can. The hash is normalized (FNV over collapsed whitespace, via
// `genPromptHash`) so a trivial reformat does NOT false-bump the version.
//
// History is a version→contentHash ledger ONLY; it carries NO runId. The
// (run, eval@version) association is preserved instead by stamping each ScoreRow
// with the eval version at scoring time — rows are immutable on a later bump and
// `scores` is already keyed by runId. There is no inter-version diffing in v3.

/**
 * The normalized content hash of an eval's criteria (judge) or golden JSON set
 * (golden). Reuses `genPromptHash` so the notebook has one content-identity
 * primitive and whitespace-only edits collapse to the same hash.
 */
export function evalContentHash(criteriaOrGolden: string): string {
  return genPromptHash(criteriaOrGolden)
}

/** A minimal eval definition the versioning upsert consumes. */
export interface EvalDef {
  key: string
  label: string
  criteriaOrGolden: string
}

/**
 * Upsert an eval definition with content-hash versioning. Returns the updated
 * eval — never mutates `existing`.
 *
 *   • New eval        → version 1, history seeded with {1, hash}.
 *   • Unchanged hash  → same version + history; only label/content text refresh
 *                       (a whitespace-only edit lands here — no false bump).
 *   • Changed hash    → version increments and {version, contentHash} is appended
 *                       to history; prior entries are retained so a row graded
 *                       under an older version still resolves to its exact content.
 */
export function upsertEvalVersion(
  existing: NotebookEval | undefined,
  def: EvalDef,
): NotebookEval {
  const contentHash = evalContentHash(def.criteriaOrGolden)
  if (!existing) {
    return {
      key: def.key,
      label: def.label,
      version: 1,
      criteriaOrGolden: def.criteriaOrGolden,
      history: [{ version: 1, contentHash }],
    }
  }
  const lastHash = existing.history[existing.history.length - 1]?.contentHash
  if (lastHash === contentHash) {
    return { ...existing, label: def.label, criteriaOrGolden: def.criteriaOrGolden }
  }
  const version = existing.version + 1
  return {
    ...existing,
    label: def.label,
    version,
    criteriaOrGolden: def.criteriaOrGolden,
    history: [...existing.history, { version, contentHash }],
  }
}

/**
 * Whether an eval has been revised at least once — i.e. its version is ≥ 2. The
 * "a judge is a prompt — tune it like one" copy is GATED on this (it only earns
 * its place once an eval has actually been revised). Pure predicate; the UI reads
 * it, this module owns the rule.
 */
export function isRevised(evalDef: Pick<NotebookEval, 'version'>): boolean {
  return evalDef.version >= 2
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

// ── Projection: the eval-row score trail (the simple score line) ──────────────

/**
 * One step of an eval-row trail: a scored run plus the rolled-up frac that run
 * earned for the eval. Carries the run identity (`runId` + monotonic `version`)
 * so the line can label its columns, and the full `row` so the step is a genuine
 * window onto the cube — never a flattened copy.
 */
export interface TrailStep {
  runId: string
  /** The producing run's monotonic version, for a "run N" label. */
  version: number
  /** The rolled-up "n/m" frac for this (eval, run) cell. */
  frac: string
  /** The whole score row this step projects — the cube cell itself. */
  row: ScoreRow
}

/**
 * Project the eval-ROW trail behind the simple score line: walk `state.runs` in
 * order, keep only runs that have a score cell for `evalKey`, and return the last
 * `limit` of them (chronological, so prev → current). This is the SAME object as
 * the grid — one row of `scores` sampled across runs — never a parallel
 * structure; the grid (N15b) reads the very same cells, just at full width.
 *
 * Runs without a cell for this eval are skipped (a run scored under a different
 * eval is not part of this row). Returns an empty array when the eval has no
 * scored runs.
 */
export function projectEvalTrail(
  state: NotebookState,
  evalKey: string,
  limit = 3,
): TrailStep[] {
  const row = state.scores[evalKey]
  if (!row) return []
  const steps: TrailStep[] = []
  for (const run of state.runs) {
    const cell = row[run.id]
    if (cell) steps.push({ runId: run.id, version: run.version, frac: cell.frac, row: cell })
  }
  return limit > 0 ? steps.slice(-limit) : steps
}

/** The eval keys that currently have at least one scored run, in `scores` order. */
export function scoredEvalKeys(state: NotebookState): string[] {
  return Object.keys(state.scores).filter((k) => Object.keys(state.scores[k]).length > 0)
}

/**
 * The runs that have at least one score cell, in `state.runs` (chronological)
 * order. These are the GRID's columns — a run with no scored eval is not a
 * column, and the last one is the "current" run the grid highlights. Like the
 * trail, this is a pure projection of the cube; it stores nothing new.
 */
export function scoredRunsInOrder(state: NotebookState): NotebookRun[] {
  const evalKeys = Object.keys(state.scores)
  return state.runs.filter((run) => evalKeys.some((k) => state.scores[k]?.[run.id]))
}
