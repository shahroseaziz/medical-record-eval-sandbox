// ── Iteration delta — previous-vs-current comparison (O8 / E27 / design G3) ───
//
// The read side of the round-trip's payoff: once a re-run has rotated the last
// fully-scored run into `runs.previous` (S22), this module compares that baseline
// against `runs.current` and tells the surface what moved — per-case verdict flips
// and the aggregate pass-rate move — with the n the comparison rests on.
//
// Two axes, NEVER conflated (E27):
//
//   • The gen-prompt axis ANNOTATES. A changed `genPromptHash` across the two runs
//     is the EXPECTED state of a valid delta — the gen-prompt edit IS the thing being
//     measured (G3). The number still renders; it just carries a "compared across
//     different generation prompts" note. A *mixed-prompt current run* (selective
//     regen left outputs at different `genPromptHash`es, S23, so the run-level hash is
//     undefined) is the one gen-prompt case that SUPPRESSES the number — the run isn't
//     a single coherent prompt yet, so there is nothing well-defined to compare until
//     the full set is regenerated to one hash.
//
//   • The rubric/threshold/scorer axis SUPPRESSES. The per-case-flip + aggregate-move
//     *number* renders only when rubric + threshold + scorer assignments match across
//     the two runs; divergence on any of those three fires the E8-pattern comparability
//     banner IN PLACE of the number — you can't read a delta across a moved judge.
//
// n-honesty (design G3): every delta carries its n, copy is "k case(s) flipped (n=m)"
// — never causal celebration ("75% → 100%, your change worked"). A one-case flip on a
// single-digit set is exactly the mistake this app exists to teach against, so the
// surface also names the ≥100-case-floor tension instead of hiding it. This module
// computes the honest numbers; the surface renders them soberly.

import type { BenchFieldScorer, BenchRun } from '@/lib/cases'
import type { RowResult } from '@/lib/eval/row-aggregate'

/** A clean per-case verdict — only matched/mismatched rows carry one. */
export type DeltaVerdict = 'pass' | 'fail'

/**
 * What the surface should do with the delta:
 *   • `ok`           — render the number (optionally annotated; see `acrossPrompts`)
 *   • `no-baseline`  — nothing to compare yet (no scored previous, or no scored current)
 *   • `mixed-prompt` — current run spans multiple gen prompts (S23) → suppress, banner
 *   • `incomparable` — rubric/threshold/scorer diverged (E27) → suppress, banner
 */
export type DeltaStatus = 'ok' | 'no-baseline' | 'mixed-prompt' | 'incomparable'

/** The three fingerprint axes whose divergence SUPPRESSES the number (E27). */
export type FingerprintAxis = 'rubric' | 'threshold' | 'scorer'

export interface CaseFlip {
  caseId: string
  from: DeltaVerdict
  to: DeltaVerdict
}

export interface RunDelta {
  status: DeltaStatus
  /**
   * The honest n — cases scoreable (cleanly matched/mismatched) in BOTH runs. A case
   * that was skipped / judge-errored / rate-limited in either run, or absent from one,
   * is not comparable and never enters n.
   */
  n: number
  /** Comparable cases whose verdict changed between baseline and current. */
  flips: CaseFlip[]
  /** Pass count over the comparable set, baseline vs current. */
  previousPass: number
  currentPass: number
  /** Aggregate pass-rate move (current − previous) over n; null when n = 0. */
  aggregateMove: number | null
  /**
   * True when the two runs were generated under different gen prompts. This ANNOTATES
   * (G3) — the number still renders; it is the expected state of a real iteration delta.
   */
  acrossPrompts: boolean
  /** Which fingerprint axes diverged (drives the `incomparable` banner copy). */
  divergedAxes: FingerprintAxis[]
  /**
   * Below the source curricula's ≥100-case floor — true for our single-digit sets.
   * The surface names this tension rather than hiding it (G3).
   */
  belowFloor: boolean
  /** G3 flip copy — "1 case flipped (n=4)". Empty string when there is no number. */
  copy: string
  /** Banner text when suppressed (mixed-prompt / incomparable); null when the number renders. */
  banner: string | null
}

/** The source curricula's sample-size floor; single-digit sets fall far below it (G3). */
export const CASE_FLOOR = 100

/** A row carries a clean verdict only when it is matched or mismatched (not excluded). */
function verdictOf(row: RowResult | undefined): DeltaVerdict | null {
  if (!row || row.excluded) return null
  if (row.state === 'matched') return 'pass'
  if (row.state === 'mismatched') return 'fail'
  return null
}

/** Distinct gen-prompt hashes across a run's outputs — size > 1 ⇒ a mixed-prompt run (S23). */
function distinctGenHashes(run: BenchRun): Set<string> {
  return new Set(Object.values(run.outputs).map((o) => o.genPromptHash))
}

/** Whether a run grades any case with an LLM judge (faithfulness / reference-judge). */
function usesJudge(run: BenchRun): boolean {
  return Object.values(run.scorerAssignments).some((fields) =>
    Object.values(fields).some((s: BenchFieldScorer) => s === 'faithfulness' || s === 'reference-judge'),
  )
}

/** Stable stringification of a field→scorer map (key order independent). */
function stableScorers(fields: Record<string, BenchFieldScorer>): string {
  return Object.keys(fields)
    .sort()
    .map((k) => `${k}:${fields[k]}`)
    .join('|')
}

/**
 * Which of the three suppressing fingerprint axes diverged across the two runs.
 *
 * • rubric    — `rubricHash` differs (the judge verdict rubric moved).
 * • threshold — the pass cutoff moved — but ONLY when a judge is in play. Deterministic
 *               structured-diff is threshold-invariant (it grades at 1.0), so a threshold
 *               difference between two diff-only runs is not a real divergence (per the
 *               BenchRun.threshold contract) and must not fire a false comparability banner.
 * • scorer    — any case common to both runs has a different scorer assignment (a judge moved
 *               onto/off a field). Compared over the intersection — that is the set the delta
 *               would be computed over anyway.
 */
function divergedFingerprintAxes(previous: BenchRun, current: BenchRun): FingerprintAxis[] {
  const axes: FingerprintAxis[] = []

  if (previous.rubricHash !== current.rubricHash) axes.push('rubric')

  if (previous.threshold !== current.threshold && (usesJudge(previous) || usesJudge(current))) {
    axes.push('threshold')
  }

  const commonCaseIds = Object.keys(previous.scorerAssignments).filter(
    (id) => id in current.scorerAssignments,
  )
  const scorerMoved = commonCaseIds.some(
    (id) => stableScorers(previous.scorerAssignments[id]) !== stableScorers(current.scorerAssignments[id]),
  )
  if (scorerMoved) axes.push('scorer')

  return axes
}

function pluralCase(k: number): string {
  return k === 1 ? 'case' : 'cases'
}

/** A suppressed / no-number delta with the shared shape filled in. */
function suppressed(status: DeltaStatus, banner: string | null, divergedAxes: FingerprintAxis[]): RunDelta {
  return {
    status,
    n: 0,
    flips: [],
    previousPass: 0,
    currentPass: 0,
    aggregateMove: null,
    acrossPrompts: false,
    divergedAxes,
    belowFloor: false,
    copy: '',
    banner,
  }
}

const MIXED_PROMPT_BANNER =
  'Run spans multiple generation prompts — regenerate the full set to compare.'

/** The E8-pattern comparability banner copy, naming the axis/axes that moved (E27). */
function incomparableBanner(axes: FingerprintAxis[]): string {
  const label: Record<FingerprintAxis, string> = {
    rubric: 'judge rubric',
    threshold: 'pass threshold',
    scorer: 'scorer assignment',
  }
  const moved = axes.map((a) => label[a]).join(', ')
  return `Can't read a delta — the ${moved} changed between runs. Match it to the baseline to compare.`
}

/**
 * Compute the previous-vs-current delta (O8 / E27 / G3).
 *
 * Precedence:
 *   1. no baseline / no scored current        → `no-baseline` (nothing to compare)
 *   2. rubric / threshold / scorer divergence  → `incomparable` (E27 suppresses) — the
 *      primary gate: "the number renders whenever rubric + threshold + scorer match"
 *   3. current run is mixed-prompt (S23)       → `mixed-prompt` (suppress until one hash)
 *   4. otherwise                               → `ok`; annotate when gen prompts differ (G3)
 *
 * The gen-prompt difference in (4) ANNOTATES, never suppresses — the two axes are never
 * conflated. n counts only cases scoreable in BOTH runs.
 */
export function computeRunDelta(
  previous: BenchRun | null | undefined,
  current: BenchRun | null | undefined,
): RunDelta {
  // (1) A delta needs a scored baseline AND a scored current run.
  if (!previous || !current) return suppressed('no-baseline', null, [])
  const previousScored = Object.keys(previous.scores).length > 0
  const currentScored = Object.keys(current.scores).length > 0
  if (!previousScored || !currentScored) return suppressed('no-baseline', null, [])

  // (2) Rubric/threshold/scorer axis — the gate that SUPPRESSES the number (E27).
  const divergedAxes = divergedFingerprintAxes(previous, current)
  if (divergedAxes.length > 0) {
    return suppressed('incomparable', incomparableBanner(divergedAxes), divergedAxes)
  }

  // (3) Mixed-prompt current run (S23) — the one gen-prompt case that SUPPRESSES, because
  // the run-level genPromptHash isn't well-defined until the full set is on one hash.
  if (distinctGenHashes(current).size > 1) {
    return suppressed('mixed-prompt', MIXED_PROMPT_BANNER, [])
  }

  // (4) Comparable: the number renders. Compute flips + aggregate move over the cases
  // cleanly scoreable in BOTH runs (the honest n).
  const flips: CaseFlip[] = []
  let previousPass = 0
  let currentPass = 0
  let n = 0
  for (const caseId of Object.keys(current.scores)) {
    const to = verdictOf(current.scores[caseId])
    const from = verdictOf(previous.scores[caseId])
    if (from === null || to === null) continue // not comparable in both runs
    n++
    if (from === 'pass') previousPass++
    if (to === 'pass') currentPass++
    if (from !== to) flips.push({ caseId, from, to })
  }

  const aggregateMove = n > 0 ? currentPass / n - previousPass / n : null

  // The gen-prompt axis ANNOTATES (G3): both runs are single-hash here (mixed-prompt was
  // handled above), so a hash difference is a genuine across-prompts comparison.
  const acrossPrompts = previous.genPromptHash !== current.genPromptHash

  const copy = `${flips.length} ${pluralCase(flips.length)} flipped (n=${n})`

  return {
    status: 'ok',
    n,
    flips,
    previousPass,
    currentPass,
    aggregateMove,
    acrossPrompts,
    divergedAxes: [],
    belowFloor: n > 0 && n < CASE_FLOOR,
    copy,
    banner: null,
  }
}

const ANNOTATION = 'Compared across different generation prompts — that edit is the change being measured.'

/** The across-prompts annotation copy (G3) — shown alongside the number, never in place of it. */
export function deltaAnnotation(delta: RunDelta): string | null {
  return delta.status === 'ok' && delta.acrossPrompts ? ANNOTATION : null
}

/** The ≥100-case-floor tension copy (G3), shown whenever a real number rests on a small n. */
export function floorCaveat(delta: RunDelta): string | null {
  if (delta.status !== 'ok' || !delta.belowFloor) return null
  return `n=${delta.n} is far below the ≥${CASE_FLOOR}-case floor these methods assume — read this as a signal to investigate, not proof your change worked.`
}
