// ── Run round-trip — write path (S22 / E27) ──────────────────────────────────
//
// The write half of the run round-trip (O7a). It implements the E27 *reversal*
// of the pivot's frozen-capture: regeneration no longer feeds a display-only
// side panel — it streams into `runs.current.outputs` on the BenchSet store, and
// every completed output persists to localStorage immediately so a page reload
// never loses a paid generation (the walk's central defect + the lost-to-refresh
// failure mode).
//
// This module owns the write path AND the O7b scoring round-trip: scoring writes
// `runs.current.scores`, and a COMPLETED scoring pass rotates current→previous
// (the new baseline) before the next regeneration begins (S22). The one invariant
// this layer must never violate is S22's baseline-preservation / run-slot rule:
//
//   An aborted / unscored regeneration NEVER touches `runs.previous`, and
//   `previous` holds ONLY the last *fully scored* run — a partially-scored
//   `current` is never promoted.
//
// `runs.previous` is the last *fully scored* baseline the O8 delta view rests on;
// beginning a run and persisting outputs only ever read/replace `runs.current`,
// so an abort (or a reload mid-run) leaves the baseline byte-identical and
// delta-able. Rotation is the ONLY operation that moves a run into `previous`, and
// it is gated on `isScoringComplete` — so a partial scoring pass can never lose the
// baseline. The pure functions (`beginRun`, `writeOutput`, `writeScore`,
// `rotateCompletedRun`) carry the invariant structurally — they thread
// `runs.previous` through untouched (or replace it only with a fully-scored run) —
// and the store wrappers (`startRun`, `persistOutput`, `persistScore`) are the
// impure, persist-immediately edge.

import {
  genPromptHash,
  loadBenchStore,
  saveBenchSet,
  type BenchCaseV4,
  type BenchFieldScorer,
  type BenchRun,
  type BenchRunOutput,
  type BenchSet,
} from '@/lib/cases'
import type { RowResult } from '@/lib/eval/row-aggregate'

// The bench's own store-backed set. The open workbench (R11) regenerates the
// lesson-derived golden set; those runs need a home in the v4 store so the
// round-trip is real (persisted + reload-survivable) rather than in-memory.
export const WORKBENCH_SET_ID = 'workbench'
export const WORKBENCH_SET_NAME = 'Workbench'

/** Per-case snapshot of the field→scorer map, AT run time (E27 fingerprint axis). */
export type RunScorerAssignments = Record<string, Record<string, BenchFieldScorer>>

/**
 * The E27 comparability fingerprint — ALL FOUR, never `genPromptHash` alone, or
 * the delta-validity rule is structurally uncheckable. `genPromptHash` here is
 * the run-LEVEL hash (well-defined only when every output shares one); the
 * per-output hash lives on each `BenchRunOutput` (selective-regen provenance, S23).
 */
export interface RunFingerprint {
  genPromptHash: string
  rubricHash: string
  threshold: number
  scorerAssignments: RunScorerAssignments
}

/** Thrown when an output is written with no active `runs.current` — a caller bug. */
export class NoActiveRunError extends Error {
  readonly setId: string
  constructor(setId: string) {
    super(
      `No active run for set "${setId}". Call startRun() before persisting outputs — a write with no runs.current would have no fingerprint to stamp.`,
    )
    this.name = 'NoActiveRunError'
    this.setId = setId
  }
}

// ── Hash helpers ─────────────────────────────────────────────────────────────

/**
 * Hash of the judge VERDICT rubric (the faithfulness path's strict/lenient knob),
 * one of the four fingerprint axes. Reuses the store's stable FNV string hasher so
 * a rubric move changes the fingerprint deterministically. Constant across runs for
 * a set with no faithfulness case (the rubric is simply never varied).
 */
export function hashRubric(rubric: string): string {
  return genPromptHash(rubric)
}

/**
 * The run-LEVEL gen-prompt hash. Well-defined (a single hex hash) only when EVERY
 * persisted output was generated under one gen prompt; a mixed-prompt run (selective
 * regen left outputs at different hashes, S23) collapses to '' so the O8 delta number
 * can be suppressed with the "run spans multiple generation prompts" banner. An empty
 * output set is also '' (nothing generated yet → no well-defined hash).
 */
export function deriveRunGenPromptHash(outputs: Record<string, BenchRunOutput>): string {
  const hashes = new Set(Object.values(outputs).map((o) => o.genPromptHash))
  if (hashes.size === 1) return [...hashes][0]
  return ''
}

// ── Pure run transforms (the invariant lives here) ───────────────────────────

export interface BeginRunOptions {
  rubricHash: string
  threshold: number
  scorerAssignments: RunScorerAssignments
  /** Epoch-ms run stamp; passed in (never Date.now here) so this stays deterministic. */
  timestamp: number
}

/**
 * Begin a fresh `runs.current` on the set: empty outputs/scores, the E27 fingerprint
 * stamped (run-level `genPromptHash` starts '' — it is derived as outputs land), and
 * `runs.previous` threaded through UNTOUCHED. Pure: returns a new set, mutates nothing.
 *
 * This is a FULL (re)generation start — the prior `runs.current` outputs are dropped
 * (the cases are about to be regenerated). The baseline (`runs.previous`) is the last
 * fully-scored run and is never the thing a regeneration replaces (S22), so it is
 * carried by reference, structurally guaranteeing the baseline-preservation invariant.
 */
export function beginRun(set: BenchSet, opts: BeginRunOptions): BenchSet {
  const current: BenchRun = {
    genPromptHash: '',
    rubricHash: opts.rubricHash,
    threshold: opts.threshold,
    scorerAssignments: opts.scorerAssignments,
    outputs: {},
    scores: {},
    timestamp: opts.timestamp,
  }
  return {
    ...set,
    runs: {
      current,
      previous: set.runs.previous, // the last scored baseline — untouched (S22)
    },
  }
}

/**
 * Write one completed output into `runs.current.outputs`, recomputing the run-level
 * `genPromptHash` from the merged set. Pure: returns a new set. Throws
 * NoActiveRunError when there is no current run (a write with no run has no
 * fingerprint to attach to). `runs.previous` is again threaded through untouched.
 */
export function writeOutput(set: BenchSet, caseId: string, output: BenchRunOutput): BenchSet {
  const current = set.runs.current
  if (!current) throw new NoActiveRunError(set.id)
  const outputs = { ...current.outputs, [caseId]: output }
  return {
    ...set,
    runs: {
      current: {
        ...current,
        outputs,
        genPromptHash: deriveRunGenPromptHash(outputs),
      },
      previous: set.runs.previous,
    },
  }
}

// ── Scoring + rotation (O7b — the read-back half of the round-trip) ──────────

/**
 * Write one case's row score into `runs.current.scores`, recomputing nothing else.
 * Pure: returns a new set. Throws NoActiveRunError when there is no current run (a
 * score with no run has nowhere to land). `runs.previous` is threaded through
 * untouched — scoring writes ONLY into `current`; rotation (below) is the sole path
 * a run takes into `previous`.
 */
export function writeScore(set: BenchSet, caseId: string, score: RowResult): BenchSet {
  const current = set.runs.current
  if (!current) throw new NoActiveRunError(set.id)
  return {
    ...set,
    runs: {
      current: { ...current, scores: { ...current.scores, [caseId]: score } },
      previous: set.runs.previous,
    },
  }
}

/**
 * A run is a COMPLETED scoring pass when every persisted output carries a row score
 * — i.e. scoring consumed the whole current run. An empty run (nothing generated) is
 * NOT complete (there is no baseline to rotate). This is the single predicate the
 * rotation gate and the "next regeneration" guard both read, so "completed scoring"
 * means exactly one thing across the round-trip.
 */
export function isScoringComplete(run: BenchRun): boolean {
  const outputIds = Object.keys(run.outputs)
  if (outputIds.length === 0) return false
  return outputIds.every((id) => run.scores[id] !== undefined)
}

/**
 * The rotation gate (S22 run-slot lifecycle). If the set's `current` run is a
 * COMPLETED scoring pass, rotate it into `previous` (it becomes the new baseline)
 * and clear `current`; otherwise return the set UNCHANGED. Pure.
 *
 * This is the only operation that promotes a run to `previous`, and it promotes ONLY
 * a fully-scored run — a partial / unscored `current` is left exactly where it is, so
 * the prior baseline is never lost to an aborted or half-scored run. The next
 * regeneration passes through this gate (see `startRun`), so "a completed scoring
 * pass rotates current→previous before the next regeneration begins" is structural.
 */
export function rotateCompletedRun(set: BenchSet): BenchSet {
  const current = set.runs.current
  if (!current || !isScoringComplete(current)) return set
  return {
    ...set,
    runs: { current: null, previous: current },
  }
}

// ── G5 user labels (E26) — persist independently of runs ─────────────────────
//
// The agreement labels (the user's pass/fail marks on scored outputs) are the
// user's most durable asset after the authored set itself: they live in
// `BenchSet.labels`, NOT inside any run, so they survive a baseline-vs-current
// swap, a regeneration, and a rotation untouched. These transforms thread
// `runs` through by reference — structurally guaranteeing label writes never
// perturb the run-slot lifecycle, and rotation/regeneration never drop a label.

/** Set one case's user label. Pure: returns a new set with `runs` untouched. */
export function setLabel(set: BenchSet, caseId: string, label: 'pass' | 'fail'): BenchSet {
  return { ...set, labels: { ...set.labels, [caseId]: label }, runs: set.runs }
}

/** Clear one case's user label. Pure: returns a new set with `runs` untouched. */
export function unsetLabel(set: BenchSet, caseId: string): BenchSet {
  if (set.labels[caseId] === undefined) return set
  const labels = { ...set.labels }
  delete labels[caseId]
  return { ...set, labels, runs: set.runs }
}

// ── Store wrappers (impure: load → transform → persist-immediately) ──────────

/** Find a set in the live store by id (undefined when absent). */
function findSet(setId: string): BenchSet | undefined {
  return loadBenchStore().sets.find((s) => s.id === setId)
}

export interface StartRunOptions extends BeginRunOptions {
  /** Cases the run grades over — mirrored onto the set so its scorerAssignments are anchored. */
  cases: BenchCaseV4[]
  /** Display name when the set is created on first run. */
  name?: string
}

/**
 * Start a fresh run on a store-backed set, persisting immediately. Creates the set
 * on first run (account-portable single-blob discipline, S21); on a re-run it
 * refreshes `cases` and `runs.current` but keeps `labels` and — critically —
 * `runs.previous` (the scored baseline). The save routes through `saveBenchSet`, so
 * the pre-flight quota gate and the atomic quota-guarded write both apply (a refused
 * or full store throws BenchQuotaExceededError; the prior blob — including any prior
 * baseline — stays intact). Returns the persisted set.
 */
export function startRun(setId: string, opts: StartRunOptions): BenchSet {
  const existing = findSet(setId)
  const base: BenchSet = existing ?? {
    id: setId,
    name: opts.name ?? setId,
    createdAt: opts.timestamp,
    cases: [],
    labels: {},
    runs: { current: null, previous: null },
  }
  // Rotation gate (S22): a prior run that was FULLY scored becomes the new baseline
  // before this regeneration drops `current`. A partial / unscored prior run does
  // NOT rotate — it is simply replaced and the existing baseline (`previous`) is
  // preserved. This is what makes "a completed scoring pass rotates current→previous
  // before the next regeneration begins" hold at the store edge.
  const rotated = rotateCompletedRun(base)
  const withCases: BenchSet = { ...rotated, cases: opts.cases }
  const next = beginRun(withCases, opts)
  saveBenchSet(next)
  return next
}

/**
 * Persist one case's row score into the set's current run, writing to localStorage
 * immediately. Throws NoActiveRunError when the set is missing or has no current run
 * (scoring runs against an open run — `startRun` first, or score the run rehydrated
 * after a reload). Returns the persisted set.
 */
export function persistScore(setId: string, caseId: string, score: RowResult): BenchSet {
  const set = findSet(setId)
  if (!set || !set.runs.current) throw new NoActiveRunError(setId)
  const next = writeScore(set, caseId, score)
  saveBenchSet(next)
  return next
}

/**
 * Persist one completed output into the set's current run, writing to localStorage
 * immediately — this per-completion write is what makes a generated-but-unscored
 * output survive a reload (generation is the expensive half). Throws NoActiveRunError
 * when the set is missing or has no current run (the caller must startRun first).
 */
export function persistOutput(setId: string, caseId: string, output: BenchRunOutput): BenchSet {
  const set = findSet(setId)
  if (!set || !set.runs.current) throw new NoActiveRunError(setId)
  const next = writeOutput(set, caseId, output)
  saveBenchSet(next)
  return next
}

/**
 * Read the current run's persisted outputs for a set (empty when no set / no run).
 * The rehydration source after a reload — the surface reads this to restore the
 * generated outputs the user already paid for.
 */
export function currentOutputs(setId: string): Record<string, BenchRunOutput> {
  return findSet(setId)?.runs.current?.outputs ?? {}
}

/**
 * Read the current run's persisted row scores for a set (empty when no set / no run).
 * The rehydration source for the scored surface after a reload — paired with
 * `currentOutputs`, it restores both the outputs the user generated and the scores
 * they ran, so resume-scoring picks up exactly the cases still missing a score.
 */
export function currentScores(setId: string): Record<string, RowResult> {
  return findSet(setId)?.runs.current?.scores ?? {}
}

/**
 * Read a set's user labels (empty when no set). The rehydration source for the
 * clinician-agreement surface — labels live on the set, not a run, so this is
 * stable across regenerations and reloads.
 */
export function currentLabels(setId: string): Record<string, 'pass' | 'fail'> {
  return findSet(setId)?.labels ?? {}
}

/**
 * Persist one case's user label, writing to localStorage immediately. Creates the
 * set on first label (a user may label the pre-loaded bench outputs before ever
 * starting a run of their own), preserving an empty run-slot pair so labels and
 * runs stay orthogonal. Routes through `saveBenchSet`, so the quota gate applies.
 * Returns the persisted set.
 */
export function persistLabel(setId: string, caseId: string, label: 'pass' | 'fail'): BenchSet {
  const base: BenchSet = findSet(setId) ?? {
    id: setId,
    name: setId,
    createdAt: 0,
    cases: [],
    labels: {},
    runs: { current: null, previous: null },
  }
  const next = setLabel(base, caseId, label)
  saveBenchSet(next)
  return next
}

/**
 * Clear one case's user label, persisting immediately. No-op (returns the set
 * unchanged, still persisted) when the set or label is absent. Returns the set.
 */
export function clearLabel(setId: string, caseId: string): BenchSet {
  const set = findSet(setId)
  if (!set) {
    return {
      id: setId,
      name: setId,
      createdAt: 0,
      cases: [],
      labels: {},
      runs: { current: null, previous: null },
    }
  }
  const next = unsetLabel(set, caseId)
  saveBenchSet(next)
  return next
}

/**
 * Whether the set's current run is a completed scoring pass (every output scored).
 * Drives the "ready to rotate / regenerate" state on the surface: a completed pass
 * is the one that becomes the baseline at the next regeneration. False when there is
 * no current run.
 */
export function isCurrentScoringComplete(setId: string): boolean {
  const run = findSet(setId)?.runs.current
  return run ? isScoringComplete(run) : false
}

/** The current run's stamped fingerprint, or null when there is no active run. */
export function currentFingerprint(setId: string): RunFingerprint | null {
  const run = findSet(setId)?.runs.current
  if (!run) return null
  return {
    genPromptHash: run.genPromptHash,
    rubricHash: run.rubricHash,
    threshold: run.threshold,
    scorerAssignments: run.scorerAssignments,
  }
}
