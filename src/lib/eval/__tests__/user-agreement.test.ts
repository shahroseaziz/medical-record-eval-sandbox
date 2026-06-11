import { describe, it, expect } from 'vitest'
import {
  computeUserAgreement,
  computeLabelAgreement,
  DEFAULT_PASS_THRESHOLD,
} from '../user-agreement'
import type { UserRunCaseResult } from '../user-agreement'

let seq = 0
function makeCase(
  overrides: Partial<UserRunCaseResult> & Pick<UserRunCaseResult, 'intentLabel' | 'faithfulnessScore' | 'zeroClaimFlag'>,
): UserRunCaseResult {
  return {
    caseId: 'c-' + (seq++).toString(),
    taskPrompt: 'What medications?',
    claims: [],
    output: 'Some output.',
    ...overrides,
  }
}

describe('computeUserAgreement', () => {
  it('returns null agreement and n=0 for empty input', () => {
    const result = computeUserAgreement([], DEFAULT_PASS_THRESHOLD)
    expect(result.agreement).toBeNull()
    expect(result.n).toBe(0)
    expect(result.nExcluded).toBe(0)
    expect(result.agreeCount).toBe(0)
  })

  it('excludes zero-claim cases from denominator', () => {
    const cases = [
      makeCase({ intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: true }),
      makeCase({ intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: true }),
    ]
    const result = computeUserAgreement(cases, DEFAULT_PASS_THRESHOLD)
    expect(result.agreement).toBeNull()
    expect(result.n).toBe(0)
    expect(result.nExcluded).toBe(2)
  })

  it('retains designed-fail cases in denominator', () => {
    const cases = [
      // designed-fail, score low → judge says FAIL → AGREE
      makeCase({ intentLabel: 'fail', faithfulnessScore: 0.1, zeroClaimFlag: false }),
    ]
    const result = computeUserAgreement(cases, DEFAULT_PASS_THRESHOLD)
    expect(result.n).toBe(1)
    expect(result.agreeCount).toBe(1)
    expect(result.agreement).toBeCloseTo(1.0)
    expect(result.nExcluded).toBe(0)
  })

  it('designed-fail retained even when judge says PASS (disagreement case)', () => {
    const cases = [
      // designed-fail, score high → judge says PASS → DISAGREE
      makeCase({ intentLabel: 'fail', faithfulnessScore: 0.9, zeroClaimFlag: false }),
    ]
    const result = computeUserAgreement(cases, DEFAULT_PASS_THRESHOLD)
    expect(result.n).toBe(1)
    expect(result.agreeCount).toBe(0)
    expect(result.agreement).toBeCloseTo(0.0)
  })

  it('computes correct agreement fraction', () => {
    const cases = [
      makeCase({ intentLabel: 'pass', faithfulnessScore: 0.95, zeroClaimFlag: false }), // judge PASS, label pass → agree
      makeCase({ intentLabel: 'fail', faithfulnessScore: 0.10, zeroClaimFlag: false }), // judge FAIL, label fail → agree
      makeCase({ intentLabel: 'pass', faithfulnessScore: 0.40, zeroClaimFlag: false }), // judge FAIL, label pass → disagree
    ]
    const result = computeUserAgreement(cases, DEFAULT_PASS_THRESHOLD)
    expect(result.n).toBe(3)
    expect(result.agreeCount).toBe(2)
    expect(result.agreement).toBeCloseTo(2 / 3)
  })

  it('threshold boundary: score exactly equal to threshold counts as pass', () => {
    const cases = [
      makeCase({ intentLabel: 'pass', faithfulnessScore: 0.85, zeroClaimFlag: false }),
    ]
    const result = computeUserAgreement(cases, 0.85)
    // 0.85 >= 0.85 → judge PASS → matches intentLabel='pass' → agree
    expect(result.agreeCount).toBe(1)
    expect(result.agreement).toBeCloseTo(1.0)
  })

  it('score just below threshold counts as fail', () => {
    const cases = [
      makeCase({ intentLabel: 'pass', faithfulnessScore: 0.8499, zeroClaimFlag: false }),
    ]
    const result = computeUserAgreement(cases, 0.85)
    // 0.8499 < 0.85 → judge FAIL → does not match intentLabel='pass' → disagree
    expect(result.agreeCount).toBe(0)
    expect(result.agreement).toBeCloseTo(0.0)
  })

  it('mixed zero-claim and scoreable cases: denominator excludes zero-claim only', () => {
    const cases = [
      makeCase({ intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: true }),  // excluded
      makeCase({ intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: false }), // agree
      makeCase({ intentLabel: 'fail', faithfulnessScore: 0.1, zeroClaimFlag: false }), // agree
    ]
    const result = computeUserAgreement(cases, DEFAULT_PASS_THRESHOLD)
    expect(result.n).toBe(2)
    expect(result.nExcluded).toBe(1)
    expect(result.agreeCount).toBe(2)
    expect(result.agreement).toBeCloseTo(1.0)
  })

  it('null faithfulnessScore is excluded (same as zero-claim)', () => {
    const cases = [
      makeCase({ intentLabel: 'pass', faithfulnessScore: null, zeroClaimFlag: false }),
    ]
    const result = computeUserAgreement(cases, DEFAULT_PASS_THRESHOLD)
    expect(result.n).toBe(0)
    expect(result.nExcluded).toBe(1)
    expect(result.agreement).toBeNull()
  })

  it('custom threshold changes agreement count', () => {
    const cases = [
      // score 0.7 — above 0.5 threshold, below 0.85 default
      makeCase({ intentLabel: 'pass', faithfulnessScore: 0.7, zeroClaimFlag: false }),
    ]
    const atDefault = computeUserAgreement(cases, 0.85)
    const atLow = computeUserAgreement(cases, 0.5)
    // at 0.85: judge FAIL, intentLabel pass → disagree
    expect(atDefault.agreeCount).toBe(0)
    // at 0.50: judge PASS, intentLabel pass → agree
    expect(atLow.agreeCount).toBe(1)
  })

  it('returns n=0 when all cases are zero-claim or null score', () => {
    const cases = [
      makeCase({ intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: true }),
      makeCase({ intentLabel: 'fail', faithfulnessScore: null, zeroClaimFlag: false }),
    ]
    const result = computeUserAgreement(cases, DEFAULT_PASS_THRESHOLD)
    expect(result.n).toBe(0)
    expect(result.nExcluded).toBe(2)
    expect(result.agreement).toBeNull()
  })
})

// ── The G5 user-path metric (E26): judge verdict vs the user's OWN labels ──────
describe('computeLabelAgreement', () => {
  it('is UNPOPULATED until at least one user label exists — never a vacuous 100%', () => {
    const cases = [
      makeCase({ caseId: 'a', intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: false }),
      makeCase({ caseId: 'b', intentLabel: 'fail', faithfulnessScore: 0.1, zeroClaimFlag: false }),
    ]
    const result = computeLabelAgreement(cases, {}, DEFAULT_PASS_THRESHOLD)
    expect(result.populated).toBe(false)
    expect(result.agreement).toBeNull()
    expect(result.n).toBe(0)
    expect(result.disagreers).toEqual([])
  })

  it('only counts cases the user has labeled (intent label is ignored)', () => {
    const cases = [
      // user labels only 'a'; 'b' is unlabeled and must not enter the denominator.
      makeCase({ caseId: 'a', intentLabel: 'fail', faithfulnessScore: 0.95, zeroClaimFlag: false }),
      makeCase({ caseId: 'b', intentLabel: 'pass', faithfulnessScore: 0.1, zeroClaimFlag: false }),
    ]
    const result = computeLabelAgreement(cases, { a: 'pass' }, DEFAULT_PASS_THRESHOLD)
    expect(result.populated).toBe(true)
    expect(result.n).toBe(1)
    // judge PASS (0.95) matches the USER label 'pass' (not the intent label 'fail').
    expect(result.agreeCount).toBe(1)
    expect(result.agreement).toBeCloseTo(1.0)
  })

  it('excludes zero-claim labeled cases from the denominator', () => {
    const cases = [
      makeCase({ caseId: 'a', intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: true }),
      makeCase({ caseId: 'b', intentLabel: 'pass', faithfulnessScore: 0.95, zeroClaimFlag: false }),
    ]
    const result = computeLabelAgreement(cases, { a: 'pass', b: 'pass' }, DEFAULT_PASS_THRESHOLD)
    expect(result.populated).toBe(true) // a label exists → populated
    expect(result.n).toBe(1) // only 'b' is scoreable
    expect(result.nExcluded).toBe(1)
    expect(result.agreeCount).toBe(1)
  })

  it('populated stays true even when every labeled case is zero-claim (agreement null, not 100%)', () => {
    const cases = [
      makeCase({ caseId: 'a', intentLabel: 'pass', faithfulnessScore: 1.0, zeroClaimFlag: true }),
    ]
    const result = computeLabelAgreement(cases, { a: 'pass' }, DEFAULT_PASS_THRESHOLD)
    expect(result.populated).toBe(true)
    expect(result.n).toBe(0)
    expect(result.nExcluded).toBe(1)
    expect(result.agreement).toBeNull()
  })

  it('retains a designed-fail user label in the denominator (judge FAIL → agree)', () => {
    const cases = [
      makeCase({ caseId: 'a', intentLabel: 'pass', faithfulnessScore: 0.1, zeroClaimFlag: false }),
    ]
    const result = computeLabelAgreement(cases, { a: 'fail' }, DEFAULT_PASS_THRESHOLD)
    expect(result.n).toBe(1)
    expect(result.agreeCount).toBe(1)
    expect(result.agreement).toBeCloseTo(1.0)
    expect(result.disagreers).toEqual([])
  })

  it('reports disagreers (judge verdict ≠ user label) so they are one click away', () => {
    const cases = [
      makeCase({ caseId: 'a', intentLabel: 'pass', faithfulnessScore: 0.95, zeroClaimFlag: false }), // judge PASS, user pass → agree
      makeCase({ caseId: 'b', intentLabel: 'pass', faithfulnessScore: 0.1, zeroClaimFlag: false }), // judge FAIL, user pass → disagree
      makeCase({ caseId: 'c', intentLabel: 'fail', faithfulnessScore: 0.95, zeroClaimFlag: false }), // judge PASS, user fail → disagree
    ]
    const result = computeLabelAgreement(
      cases,
      { a: 'pass', b: 'pass', c: 'fail' },
      DEFAULT_PASS_THRESHOLD,
    )
    expect(result.n).toBe(3)
    expect(result.agreeCount).toBe(1)
    expect(result.agreement).toBeCloseTo(1 / 3)
    expect(result.disagreers.sort()).toEqual(['b', 'c'])
  })

  it('honors the threshold (a moved cutoff flips the verdict and the agreement)', () => {
    const cases = [
      makeCase({ caseId: 'a', intentLabel: 'pass', faithfulnessScore: 0.7, zeroClaimFlag: false }),
    ]
    const atDefault = computeLabelAgreement(cases, { a: 'pass' }, 0.85) // judge FAIL → disagree
    const atLow = computeLabelAgreement(cases, { a: 'pass' }, 0.5) // judge PASS → agree
    expect(atDefault.agreeCount).toBe(0)
    expect(atDefault.disagreers).toEqual(['a'])
    expect(atLow.agreeCount).toBe(1)
    expect(atLow.disagreers).toEqual([])
  })
})
