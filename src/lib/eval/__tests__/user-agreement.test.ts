import { describe, it, expect } from 'vitest'
import { computeUserAgreement, DEFAULT_PASS_THRESHOLD } from '../user-agreement'
import type { UserRunCaseResult } from '../user-agreement'

function makeCase(
  overrides: Partial<UserRunCaseResult> & Pick<UserRunCaseResult, 'intentLabel' | 'faithfulnessScore' | 'zeroClaimFlag'>,
): UserRunCaseResult {
  return {
    caseId: 'c-' + Math.random().toString(36).slice(2),
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
