import { describe, it, expect } from 'vitest'
import {
  buildBeat3Results,
  faithfulnessScore,
  loadLessonBeat3,
  meanBeat3Score,
} from '../beat3'
import { caseScore, caseVerdict, computeUserAgreement } from '@/lib/eval/user-agreement'

/**
 * Beat 3 capstone runs on committed data only — these assertions pin the exact
 * faithfulness math so the lesson can never silently drift, and prove the two
 * acceptance behaviours at the data layer: the rubric moves the score, and the
 * judge verdict diverges from the user's intent label on the designed cases.
 */
describe('lesson Beat 3 — committed faithfulness data', () => {
  const data = loadLessonBeat3()

  it('faithfulnessScore counts only supported claims (partial = not supported)', () => {
    expect(
      faithfulnessScore([
        { claim: 'a', verdict: 'supported', rationale: '' },
        { claim: 'b', verdict: 'partial', rationale: '' },
        { claim: 'c', verdict: 'unsupported', rationale: '' },
      ]),
    ).toBeCloseTo(1 / 3)
    expect(faithfulnessScore([])).toBe(1.0)
  })

  it('the rubric moves the mean score: strict 60.4% → lenient 75.0%', () => {
    expect(meanBeat3Score('strict')).toBeCloseTo(0.6041666, 4)
    expect(meanBeat3Score('lenient')).toBe(0.75)
    expect(meanBeat3Score('lenient')).toBeGreaterThan(meanBeat3Score('strict'))
  })

  it('per-case scores match supported/total under each rubric', () => {
    const strict = buildBeat3Results('strict')
    const byId = Object.fromEntries(strict.map((r) => [r.caseId, caseScore(r)]))
    expect(byId['beat3-medications-pass']).toBe(1.0)
    expect(byId['beat3-cardiac-hallucination-fail']).toBe(0.0)
    expect(byId['beat3-allergies-rubric-sensitive-fail']).toBeCloseTo(2 / 3)
    expect(byId['beat3-problems-threshold-sensitive-pass']).toBe(0.75)
  })

  it('strict rubric @0.85 disagrees only on the threshold-sensitive problem list', () => {
    const results = buildBeat3Results('strict')
    const disagree = results.filter(
      (r) => caseVerdict(r, 0.85) !== r.intentLabel,
    )
    expect(disagree.map((r) => r.caseId)).toEqual([
      'beat3-problems-threshold-sensitive-pass',
    ])
    // ...and lowering the threshold to 0.75 resolves that disagreement.
    expect(buildBeat3Results('strict').every((r) => caseVerdict(r, 0.75) === r.intentLabel)).toBe(
      true,
    )
  })

  it('lenient rubric @0.85 lets the aspirin hallucination pass — judge disagrees with the fail label', () => {
    const results = buildBeat3Results('lenient')
    const allergy = results.find((r) => r.caseId === 'beat3-allergies-rubric-sensitive-fail')!
    expect(allergy.intentLabel).toBe('fail')
    expect(caseVerdict(allergy, 0.85)).toBe('pass') // judge fooled by a plausible hallucination
  })

  it('intent-label overrides flow through without mutating the fixture', () => {
    const overridden = buildBeat3Results('strict', { 'beat3-medications-pass': 'fail' })
    const med = overridden.find((r) => r.caseId === 'beat3-medications-pass')!
    expect(med.intentLabel).toBe('fail')
    // a fresh build is unaffected
    expect(
      buildBeat3Results('strict').find((r) => r.caseId === 'beat3-medications-pass')!.intentLabel,
    ).toBe('pass')
  })

  it('agreement is computed over all four cases (small-N, designed-fails retained)', () => {
    const { n, agreement } = computeUserAgreement(buildBeat3Results('strict'), 0.85)
    expect(n).toBe(4)
    expect(agreement).toBeCloseTo(0.75) // 3 of 4 agree under strict@0.85
  })

  it('renders identically on repeated loads (no flap)', () => {
    expect(JSON.stringify(buildBeat3Results('strict'))).toBe(
      JSON.stringify(buildBeat3Results('strict')),
    )
    expect(data.cases).toHaveLength(4)
  })
})
