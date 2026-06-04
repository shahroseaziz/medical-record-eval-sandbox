import { describe, it, expect } from 'vitest'
import {
  computeMeanScore,
  computeStdDev,
  medianRunIndex,
  computeAggregate,
  computeKappa,
} from '../aggregate'
import type { FaithfulnessRunResult, CaseAggregateInput, BinaryLabel } from '../aggregate'

describe('computeMeanScore', () => {
  it('returns null for empty input', () => {
    expect(computeMeanScore([])).toBeNull()
  })

  it('returns null when all runs are zero-claim', () => {
    const runs: FaithfulnessRunResult[] = [
      { score: 1.0, zeroClaimFlag: true },
      { score: 1.0, zeroClaimFlag: true },
    ]
    expect(computeMeanScore(runs)).toBeNull()
  })

  it('returns null when all scores are null', () => {
    const runs: FaithfulnessRunResult[] = [{ score: null }, { score: null }]
    expect(computeMeanScore(runs)).toBeNull()
  })

  it('excludes zero-claim runs from mean', () => {
    const runs: FaithfulnessRunResult[] = [
      { score: 1.0, zeroClaimFlag: true },
      { score: 0.6 },
      { score: 0.8 },
    ]
    expect(computeMeanScore(runs)).toBeCloseTo(0.7)
  })

  it('computes mean over valid runs', () => {
    const runs: FaithfulnessRunResult[] = [
      { score: 0.9 },
      { score: 1.0 },
      { score: 0.8 },
    ]
    expect(computeMeanScore(runs)).toBeCloseTo(0.9)
  })

  it('excludes null scores from mean', () => {
    const runs: FaithfulnessRunResult[] = [{ score: null }, { score: 0.8 }, { score: 1.0 }]
    expect(computeMeanScore(runs)).toBeCloseTo(0.9)
  })
})

describe('computeStdDev', () => {
  it('returns 0 for empty input', () => {
    expect(computeStdDev([])).toBe(0)
  })

  it('returns 0 for a single valid run', () => {
    const runs: FaithfulnessRunResult[] = [{ score: 0.9 }]
    expect(computeStdDev(runs)).toBe(0)
  })

  it('returns 0 when all runs are zero-claim', () => {
    const runs: FaithfulnessRunResult[] = [{ score: 1.0, zeroClaimFlag: true }]
    expect(computeStdDev(runs)).toBe(0)
  })

  it('computes sample standard deviation correctly', () => {
    // [1.0, 0.0] → mean = 0.5, variance = (0.25 + 0.25)/1 = 0.5, stddev = sqrt(0.5)
    const runs: FaithfulnessRunResult[] = [{ score: 1.0 }, { score: 0.0 }]
    expect(computeStdDev(runs)).toBeCloseTo(Math.sqrt(0.5))
  })

  it('excludes zero-claim runs from stddev', () => {
    const runs: FaithfulnessRunResult[] = [
      { score: 1.0, zeroClaimFlag: true },
      { score: 1.0 },
      { score: 0.0 },
    ]
    // Should use only [1.0, 0.0]
    expect(computeStdDev(runs)).toBeCloseTo(Math.sqrt(0.5))
  })

  it('returns 0 for identical scores', () => {
    const runs: FaithfulnessRunResult[] = [{ score: 0.9 }, { score: 0.9 }, { score: 0.9 }]
    expect(computeStdDev(runs)).toBeCloseTo(0)
  })
})

describe('medianRunIndex', () => {
  it('returns 0 for empty input', () => {
    expect(medianRunIndex([])).toBe(0)
  })

  it('returns 0 for all-zero-claim input', () => {
    const runs: FaithfulnessRunResult[] = [{ score: 1.0, zeroClaimFlag: true }]
    expect(medianRunIndex(runs)).toBe(0)
  })

  it('returns index of run closest to median', () => {
    const runs: FaithfulnessRunResult[] = [{ score: 0.6 }, { score: 0.9 }, { score: 1.0 }]
    // sorted: [0.6, 0.9, 1.0], median (index 1) = 0.9 → original index 1
    expect(medianRunIndex(runs)).toBe(1)
  })

  it('skips zero-claim runs when finding median index', () => {
    const runs: FaithfulnessRunResult[] = [
      { score: 1.0, zeroClaimFlag: true }, // index 0 — skipped
      { score: 0.6 },                       // index 1
      { score: 0.9 },                       // index 2
    ]
    // valid scores: [0.6 (i=1), 0.9 (i=2)], sorted: [0.6, 0.9], median at floor(1/2)=0 → 0.6 → original index 1
    expect(medianRunIndex(runs)).toBe(1)
  })
})

describe('computeAggregate', () => {
  it('returns nulls and n=0 for empty input', () => {
    expect(computeAggregate([])).toEqual({
      passRate: null,
      judgeReferenceAgreement: null,
      n: 0,
      note: 'directional, n=6-8',
    })
  })

  it('excludes zero-claim cases', () => {
    const cases: CaseAggregateInput[] = [
      { meanScore: 1.0, referenceLabel: 'pass', zeroClaimFlag: true },
    ]
    expect(computeAggregate(cases)).toEqual({
      passRate: null,
      judgeReferenceAgreement: null,
      n: 0,
      note: 'directional, n=6-8',
    })
  })

  it('computes passRate as fraction scoring >= 0.85', () => {
    const cases: CaseAggregateInput[] = [
      { meanScore: 0.95, referenceLabel: 'pass', zeroClaimFlag: false },
      { meanScore: 0.60, referenceLabel: 'fail', zeroClaimFlag: false },
      { meanScore: 0.90, referenceLabel: 'pass', zeroClaimFlag: false },
    ]
    const result = computeAggregate(cases)
    expect(result.n).toBe(3)
    expect(result.passRate).toBeCloseTo(2 / 3)
  })

  it('computes judgeReferenceAgreement as fraction where judge matches referenceLabel', () => {
    const cases: CaseAggregateInput[] = [
      { meanScore: 0.95, referenceLabel: 'pass', zeroClaimFlag: false }, // agree: score>=0.85 AND label=pass
      { meanScore: 0.60, referenceLabel: 'fail', zeroClaimFlag: false }, // agree: score<0.85 AND label=fail
      { meanScore: 0.90, referenceLabel: 'fail', zeroClaimFlag: false }, // disagree: score>=0.85 but label=fail
    ]
    const result = computeAggregate(cases)
    expect(result.judgeReferenceAgreement).toBeCloseTo(2 / 3)
  })

  it('excludes zero-claim cases but counts non-zero-claim cases correctly', () => {
    const cases: CaseAggregateInput[] = [
      { meanScore: null, referenceLabel: 'pass', zeroClaimFlag: true },
      { meanScore: 0.95, referenceLabel: 'pass', zeroClaimFlag: false },
      { meanScore: 0.40, referenceLabel: 'fail', zeroClaimFlag: false },
    ]
    const result = computeAggregate(cases)
    expect(result.n).toBe(2)
    expect(result.passRate).toBeCloseTo(0.5)
    expect(result.judgeReferenceAgreement).toBeCloseTo(1.0)
  })

  it('handles all-pass cases', () => {
    const cases: CaseAggregateInput[] = [
      { meanScore: 0.95, referenceLabel: 'pass', zeroClaimFlag: false },
      { meanScore: 0.90, referenceLabel: 'pass', zeroClaimFlag: false },
    ]
    const result = computeAggregate(cases)
    expect(result.passRate).toBeCloseTo(1.0)
    expect(result.judgeReferenceAgreement).toBeCloseTo(1.0)
  })

  it('handles designed-fail cases scored low by judge', () => {
    const cases: CaseAggregateInput[] = [
      { meanScore: 0.95, referenceLabel: 'pass', zeroClaimFlag: false },
      { meanScore: 0.10, referenceLabel: 'fail', zeroClaimFlag: false },
    ]
    const result = computeAggregate(cases)
    expect(result.passRate).toBeCloseTo(0.5)
    expect(result.judgeReferenceAgreement).toBeCloseTo(1.0)
  })
})

describe('computeKappa', () => {
  it('returns null for empty arrays', () => {
    expect(computeKappa([], [])).toBeNull()
  })

  it('returns null for mismatched lengths', () => {
    expect(computeKappa(['supported'], ['supported', 'unsupported'])).toBeNull()
  })

  it('returns 1.0 for perfect agreement', () => {
    const labels: BinaryLabel[] = ['supported', 'supported', 'unsupported']
    expect(computeKappa(labels, labels)).toBeCloseTo(1.0)
  })

  it('returns 1.0 when both raters agree on all-supported fixture', () => {
    const labels: BinaryLabel[] = ['supported', 'supported', 'supported', 'supported']
    expect(computeKappa(labels, labels)).toBeCloseTo(1.0)
  })

  it('returns a negative kappa when raters mostly disagree', () => {
    const a: BinaryLabel[] = ['supported', 'supported', 'supported', 'unsupported']
    const b: BinaryLabel[] = ['unsupported', 'unsupported', 'supported', 'supported']
    const k = computeKappa(a, b)
    expect(k).not.toBeNull()
    expect(k!).toBeLessThan(0)
  })

  it('computes kappa correctly on a known fixture', () => {
    // po=3/4=0.75; p1pos=2/4=0.5, p2pos=2/4=0.5; pe=0.5*0.5+0.5*0.5=0.5
    // kappa=(0.75-0.5)/(1-0.5)=0.5
    const a: BinaryLabel[] = ['supported', 'supported', 'unsupported', 'unsupported']
    const b: BinaryLabel[] = ['supported', 'unsupported', 'unsupported', 'unsupported']
    expect(computeKappa(a, b)).toBeCloseTo(0.5)
  })

  it('returns ~0.9 for near-perfect agreement (calibration fixture)', () => {
    // Simulates 86 claims: 83 agree, A has 66 sup, B has 67 sup
    // Expected kappa ≈ 0.9006
    const a: BinaryLabel[] = [
      ...Array(66).fill('supported') as BinaryLabel[],
      ...Array(20).fill('unsupported') as BinaryLabel[],
    ]
    // B: 67 supported, 19 unsupported; 3 disagreements at positions 65, 66, 67
    const b: BinaryLabel[] = [
      ...Array(65).fill('supported') as BinaryLabel[],
      ...Array(1).fill('unsupported') as BinaryLabel[], // disagree at pos 65
      ...Array(1).fill('supported') as BinaryLabel[],   // disagree at pos 66
      ...Array(1).fill('supported') as BinaryLabel[],   // disagree at pos 67
      ...Array(18).fill('unsupported') as BinaryLabel[],
    ]
    const k = computeKappa(a, b)
    expect(k).not.toBeNull()
    expect(k!).toBeGreaterThan(0.85)
    expect(k!).toBeLessThanOrEqual(1.0)
  })

  it('kappa is symmetric', () => {
    const a: BinaryLabel[] = ['supported', 'supported', 'unsupported', 'supported']
    const b: BinaryLabel[] = ['supported', 'unsupported', 'unsupported', 'supported']
    expect(computeKappa(a, b)).toBeCloseTo(computeKappa(b, a)!)
  })
})
