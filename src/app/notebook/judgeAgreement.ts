// ── Do-you-agree thumbs + the two derived lines (SHA-169 N17) ────────────────
//
// All free, all CLIENT-SIDE. The do-you-agree thumbs live on JUDGE rows only and
// write an `agree` marker onto the per-patient score entry — the N4 `per[].agree`
// field, enum ['a','m'] (a = agreed, m = marked-disagree). That marker is the SOLE
// source for the later disputed-cell indicator (N15b) and for the "you: a/m" line
// here; it is NEVER folded into the judge's own pass count (agreement is a separate
// signal from the verdict).
//
// Two lines are derived from N4-shaped `per[]` arrays:
//   • "you: a/m"          — agreed among MARKED (of-marked denominator, never
//                            of-scored: the of-scored variant is a known bug).
//   • "judge-vs-golden"   — matched on the OVERLAP where a judge AND the golden
//                            both scored the same patient. NO metered calls, NO
//                            kappa, NO thresholds — a plain count, a lead not a verdict.
//
// These operate on the committed N4 `PerCaseScore` shape so the agreement signal can
// be lifted straight into the `scores` cube without a translation layer.

import type { PerCaseScore } from '@/lib/notebook/state'

/** The agree marker enum, sourced from the N4 schema so it cannot drift. */
export type AgreeMark = NonNullable<PerCaseScore['agree']>

/** A judge per-patient entry is "marked" once the user presses either thumb. */
function isMarked(p: PerCaseScore): boolean {
  return p.agree === 'a' || p.agree === 'm'
}

/** Whether a judge entry carries a settled (non-errored) verdict. */
function judgeScored(p: PerCaseScore): boolean {
  return !p.errored && (p.state === 'pass' || p.state === 'fail')
}

/** Whether a golden entry was actually graded (pass/fail, not empty/invalid). */
function goldenScored(p: PerCaseScore): boolean {
  return p.state === 'pass' || p.state === 'fail'
}

export interface YouVsJudge {
  /** Verdicts the user agreed with (agree === 'a'). */
  agreed: number
  /** Verdicts the user marked at all (agree === 'a' OR 'm') — the denominator. */
  marked: number
}

/**
 * "you: a/m" — agreed among MARKED. The denominator is of-MARKED (verdicts the user
 * actually thumbed), NOT of-scored: counting agreement against every scored verdict
 * is a known bug, so the of-marked denominator is used everywhere.
 */
export function computeYouVsJudge(judgePer: PerCaseScore[]): YouVsJudge {
  const marked = judgePer.filter(isMarked)
  const agreed = marked.filter((p) => p.agree === 'a').length
  return { agreed, marked: marked.length }
}

export interface JudgeVsGolden {
  /** Patients where the judge and golden agreed on the same pass/fail verdict. */
  matched: number
  /** Patients where a judge AND the golden both scored the same (run, patient). */
  overlap: number
}

/**
 * "judge-vs-golden m of n" — computed from the OVERLAP where a judge AND the golden
 * both scored the same patient. A match is the SAME pass/fail verdict (both the
 * judge and golden `state==='pass'`). Purely client-side: no metered call,
 * no kappa, no threshold — a lead, not a verdict.
 */
export function computeJudgeVsGolden(
  judgePer: PerCaseScore[],
  goldenPer: PerCaseScore[],
): JudgeVsGolden {
  const goldenById = new Map(goldenPer.filter(goldenScored).map((g) => [g.patientId, g]))
  const comparable = judgePer.filter((j) => judgeScored(j) && goldenById.has(j.patientId))
  const matched = comparable.filter((j) => {
    const g = goldenById.get(j.patientId)!
    return (j.state === 'pass') === (g.state === 'pass')
  }).length
  return { matched, overlap: comparable.length }
}

// ── Grid trust markers + disputed-cell (SHA-171 N15b) ────────────────────────
//
// The runs×evals grid (ScoreLine) lifts the SAME two derived counts onto each
// JUDGE row as a current-column secondary line, plus a disputed-cell indicator —
// both derived SOLELY from N4 state already on the cube (the `agree` marks and the
// golden/judge `per[]`). No new score, no metered call. GOLDEN rows carry NO
// markers (a golden has no judge-vs-golden and no agree of its own), and every
// marker reflects the CURRENT column only — the caller passes that column's rows.

/** A single trust marker on a judge row: the kind tags its tint, the text renders. */
export interface TrustMarker {
  /** `vg` = the judge-vs-golden overlap line; `you` = the of-marked agreement line. */
  kind: 'vg' | 'you'
  text: string
}

/**
 * The current-column trust markers for ONE judge row, derived from that column's
 * judge `per[]` and (when present) the golden `per[]` for the SAME run:
 *
 *   • "vs your golden m/n" — OVERLAP only: matches over patients scored by BOTH the
 *     judge and the golden on this run (`computeJudgeVsGolden`). Omitted when the
 *     golden did not score this run or there is no overlap.
 *   • "you: a/m"           — MARKED verdicts only: agreed over the of-MARKED
 *     denominator (`computeYouVsJudge`), never of-scored. Omitted when nothing is
 *     marked on this column.
 *
 * Pass golden rows nothing — this is judge-row only; the caller gates on the key.
 */
export function judgeRowMarkers(
  judgePer: PerCaseScore[],
  goldenPer: PerCaseScore[] | undefined,
): TrustMarker[] {
  const markers: TrustMarker[] = []
  if (goldenPer) {
    const { matched, overlap } = computeJudgeVsGolden(judgePer, goldenPer)
    if (overlap > 0) markers.push({ kind: 'vg', text: `vs your golden ${matched}/${overlap}` })
  }
  const { agreed, marked } = computeYouVsJudge(judgePer)
  if (marked > 0) markers.push({ kind: 'you', text: `you: ${agreed}/${marked}` })
  return markers
}

/**
 * Whether a score cell holds a DISPUTED verdict — derived SOLELY from the N4
 * `agree` marks: a verdict the user marked disagree (`agree === 'm'`) disputes its
 * cell. Nothing else feeds this — not the judge's pass/fail, not a golden mismatch.
 * Golden cells never carry an `agree`, so a golden cell is never disputed.
 */
export function hasDisputedVerdict(per: PerCaseScore[]): boolean {
  return per.some((p) => p.agree === 'm')
}
