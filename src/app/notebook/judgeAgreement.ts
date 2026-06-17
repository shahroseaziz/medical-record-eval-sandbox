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
  return typeof p.pass === 'boolean'
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
 * both scored the same patient. A match is the SAME pass/fail verdict (judge
 * `state==='pass'` vs golden `pass===true`). Purely client-side: no metered call,
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
    return (j.state === 'pass') === (g.pass === true)
  }).length
  return { matched, overlap: comparable.length }
}
