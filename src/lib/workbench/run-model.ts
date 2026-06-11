// ── Run round-trip — write path (S22 / E27) ──────────────────────────────────
//
// The write half of the run round-trip (O7a). It implements the E27 *reversal*
// of the pivot's frozen-capture: regeneration no longer feeds a display-only
// side panel — it streams into `runs.current.outputs` on the BenchSet store, and
// every completed output persists to localStorage immediately so a page reload
// never loses a paid generation (the walk's central defect + the lost-to-refresh
// failure mode).
//
// This module owns ONLY the write path. Scoring (`runs.current.scores`) and the
// completed-score rotation current→previous are SHA-O7b — deliberately absent
// here. The one invariant this layer must never violate is S22's
// baseline-preservation rule:
//
//   An aborted / unscored regeneration NEVER touches `runs.previous`.
//
// `runs.previous` is the last *fully scored* baseline the O8 delta view rests on;
// beginning a run and persisting outputs only ever read/replace `runs.current`,
// so an abort (or a reload mid-run) leaves the baseline byte-identical and
// delta-able. The pure functions (`beginRun`, `writeOutput`) carry the invariant
// structurally — they thread `runs.previous` through untouched — and the
// store wrappers (`startRun`, `persistOutput`) are the impure, persist-immediately
// edge.

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
  const withCases: BenchSet = { ...base, cases: opts.cases }
  const next = beginRun(withCases, opts)
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
