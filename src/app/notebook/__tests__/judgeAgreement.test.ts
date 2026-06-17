import { describe, it, expect } from 'vitest'
import { computeYouVsJudge, computeJudgeVsGolden } from '../judgeAgreement'
import type { PerCaseScore } from '@/lib/notebook/state'

// SHA-169 N17 — the two derived lines, computed on N4-shaped per[] arrays.
//   • "you: a/m"         — of-MARKED denominator (NOT of-scored — that's the bug).
//   • "judge-vs-golden"  — the overlap where a judge AND the golden both scored.

function judge(patientId: string, pass: boolean, agree?: 'a' | 'm'): PerCaseScore {
  return { patientId, state: pass ? 'pass' : 'fail', fails: [], agree }
}
function judgeErr(patientId: string): PerCaseScore {
  return { patientId, errored: true, fails: [] }
}
function golden(patientId: string, pass: boolean): PerCaseScore {
  return { patientId, pass, fails: [] }
}

describe('computeYouVsJudge — of-marked denominator', () => {
  it('counts agreed among MARKED, not among scored', () => {
    // 4 scored verdicts; the user marked only two (one agree, one disagree).
    const per = [judge('p1', true, 'a'), judge('p2', false, 'm'), judge('p3', true), judge('p4', false)]
    const r = computeYouVsJudge(per)
    // of-MARKED: 1 agreed of 2 marked — NOT 1 of 4 scored.
    expect(r).toEqual({ agreed: 1, marked: 2 })
  })

  it('is 0/0 when nothing is marked (no thumbs pressed)', () => {
    expect(computeYouVsJudge([judge('p1', true), judge('p2', false)])).toEqual({
      agreed: 0,
      marked: 0,
    })
  })

  it('treats every marked verdict as part of the denominator, agree or disagree', () => {
    const per = [judge('p1', true, 'a'), judge('p2', true, 'a'), judge('p3', false, 'm')]
    expect(computeYouVsJudge(per)).toEqual({ agreed: 2, marked: 3 })
  })
})

describe('computeJudgeVsGolden — overlap only', () => {
  it('matches on the same pass/fail verdict over the shared (run, patient) set', () => {
    const judgePer = [judge('p1', true), judge('p2', false), judge('p3', true)]
    // p1 agrees (both pass), p2 disagrees (judge fail, golden pass); p3 has no golden.
    const goldenPer = [golden('p1', true), golden('p2', true)]
    expect(computeJudgeVsGolden(judgePer, goldenPer)).toEqual({ matched: 1, overlap: 2 })
  })

  it('excludes errored judge rows and ungraded goldens from the overlap', () => {
    const judgePer = [judge('p1', true), judgeErr('p2'), judge('p3', false)]
    // p2 errored (no judge verdict); p3 has no golden → overlap is just p1.
    const goldenPer = [golden('p1', true), golden('p2', true)]
    expect(computeJudgeVsGolden(judgePer, goldenPer)).toEqual({ matched: 1, overlap: 1 })
  })

  it('is empty when there is no golden at all', () => {
    expect(computeJudgeVsGolden([judge('p1', true)], [])).toEqual({ matched: 0, overlap: 0 })
  })
})
