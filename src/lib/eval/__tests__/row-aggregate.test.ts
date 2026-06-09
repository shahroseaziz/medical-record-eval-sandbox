import { describe, it, expect } from 'vitest'
import {
  classifyField,
  rollUpRow,
  scoreRow,
  scorerThreshold,
  isScoreableState,
  rowScorers,
} from '../row-aggregate'
import type { FieldScoreOutcome } from '../row-aggregate'
import type { Thresholds } from '../thresholds'
import { computeUserAgreement, toUserRunCaseResult, caseScore, caseExcluded } from '../user-agreement'

const THRESHOLDS: Thresholds = {
  faithfulness: 0.85,
  contains: 1.0,
  referenceJudge: 0.8,
  judgeKappaMin: 0.4,
  extractionCompleteness: 0.0,
  structuredDiff: 0.7,
}

describe('scorerThreshold', () => {
  it('maps each scorer to its configured threshold', () => {
    expect(scorerThreshold('faithfulness', THRESHOLDS)).toBe(0.85)
    expect(scorerThreshold('reference-judge', THRESHOLDS)).toBe(0.8)
    expect(scorerThreshold('structured-diff', THRESHOLDS)).toBe(0.7)
    expect(scorerThreshold('contains', THRESHOLDS)).toBe(1.0)
    expect(scorerThreshold('extraction-completeness', THRESHOLDS)).toBe(0.0)
  })

  it('requires a perfect score for binary section-hit (no configured threshold)', () => {
    expect(scorerThreshold('section-hit', THRESHOLDS)).toBe(1.0)
  })
})

describe('classifyField', () => {
  it('matched when score meets the threshold', () => {
    const r = classifyField({ field: 'structured', scorer: 'structured-diff', score: 0.7 }, 0.7)
    expect(r.state).toBe('matched')
    expect(r.score).toBe(0.7)
  })

  it('mismatched when score falls below the threshold', () => {
    const r = classifyField({ field: 'structured', scorer: 'structured-diff', score: 0.6 }, 0.7)
    expect(r.state).toBe('mismatched')
    expect(r.score).toBe(0.6)
  })

  it('judge-errored for a judge scorer that errored — score nulled', () => {
    const r = classifyField(
      { field: 'prose', scorer: 'reference-judge', score: 0.5, errored: true },
      0.8,
    )
    expect(r.state).toBe('judge-errored')
    expect(r.score).toBeNull()
  })

  it('rate-limited wins over a partial score', () => {
    const r = classifyField(
      { field: 'prose', scorer: 'faithfulness', score: 0.9, rateLimited: true },
      0.85,
    )
    expect(r.state).toBe('rate-limited')
    expect(r.score).toBeNull()
  })

  it('rate-limited wins over an error', () => {
    const r = classifyField(
      { field: 'prose', scorer: 'faithfulness', score: null, errored: true, rateLimited: true },
      0.85,
    )
    expect(r.state).toBe('rate-limited')
  })

  it('skipped when there is nothing to grade', () => {
    const r = classifyField({ field: 'structured', scorer: 'structured-diff', score: null, skipped: true }, 0.7)
    expect(r.state).toBe('skipped')
    expect(r.score).toBeNull()
  })

  it('zero-claim faithfulness is skipped (excluded from aggregates)', () => {
    const r = classifyField(
      { field: 'prose', scorer: 'faithfulness', score: 1.0, zeroClaimFlag: true },
      0.85,
    )
    expect(r.state).toBe('skipped')
    expect(r.score).toBeNull()
  })

  it('null score with no other signal is skipped', () => {
    const r = classifyField({ field: 'structured', scorer: 'structured-diff', score: null }, 0.7)
    expect(r.state).toBe('skipped')
  })

  it('a non-judge scorer error does NOT become judge-errored', () => {
    const r = classifyField(
      { field: 'structured', scorer: 'structured-diff', score: null, errored: true },
      0.7,
    )
    // structured-diff is deterministic; an "error" with no score is just skipped.
    expect(r.state).toBe('skipped')
  })

  it('boundary: score exactly at threshold counts as matched', () => {
    const r = classifyField({ field: 'prose', scorer: 'faithfulness', score: 0.85 }, 0.85)
    expect(r.state).toBe('matched')
  })
})

describe('isScoreableState', () => {
  it('only matched/mismatched are scoreable', () => {
    expect(isScoreableState('matched')).toBe(true)
    expect(isScoreableState('mismatched')).toBe(true)
    expect(isScoreableState('judge-errored')).toBe(false)
    expect(isScoreableState('rate-limited')).toBe(false)
    expect(isScoreableState('skipped')).toBe(false)
  })
})

describe('rollUpRow — mixed diff + judge', () => {
  it('averages a matched diff and a matched judge into a matched row', () => {
    const row = scoreRow(
      'c1',
      [
        { field: 'structured', scorer: 'structured-diff', score: 0.9 },
        { field: 'prose', scorer: 'reference-judge', score: 1.0 },
      ],
      THRESHOLDS,
    )
    expect(row.state).toBe('matched')
    expect(row.score).toBeCloseTo(0.95)
    expect(row.excluded).toBe(false)
    expect(rowScorers(row.fields)).toEqual(['structured-diff', 'reference-judge'])
  })

  it('a mixed row is mismatched when any scoreable field mismatches', () => {
    const row = scoreRow(
      'c2',
      [
        { field: 'structured', scorer: 'structured-diff', score: 0.9 }, // matched
        { field: 'prose', scorer: 'reference-judge', score: 0.5 }, // mismatched (< 0.8)
      ],
      THRESHOLDS,
    )
    expect(row.state).toBe('mismatched')
    expect(row.score).toBeCloseTo(0.7) // (0.9 + 0.5) / 2
    expect(row.excluded).toBe(false)
  })

  it('a judge-errored field makes the whole row judge-errored and excluded', () => {
    const row = scoreRow(
      'c3',
      [
        { field: 'structured', scorer: 'structured-diff', score: 0.95 }, // matched
        { field: 'prose', scorer: 'faithfulness', score: null, errored: true },
      ],
      THRESHOLDS,
    )
    expect(row.state).toBe('judge-errored')
    expect(row.excluded).toBe(true)
    // The diff field still scored; its score survives for display, but the row is excluded.
    expect(row.score).toBeCloseTo(0.95)
  })

  it('rate-limited dominates judge-errored at the row level', () => {
    const row = scoreRow(
      'c4',
      [
        { field: 'structured', scorer: 'structured-diff', score: null, errored: true }, // -> skipped
        { field: 'prose', scorer: 'faithfulness', score: 0.9, rateLimited: true },
      ],
      THRESHOLDS,
    )
    expect(row.state).toBe('rate-limited')
    expect(row.excluded).toBe(true)
  })

  it('skips the diff field but scores on the judge field alone', () => {
    const row = scoreRow(
      'c5',
      [
        { field: 'structured', scorer: 'structured-diff', score: null, skipped: true },
        { field: 'prose', scorer: 'reference-judge', score: 0.9 },
      ],
      THRESHOLDS,
    )
    expect(row.state).toBe('matched')
    expect(row.score).toBeCloseTo(0.9) // skipped field excluded from the mean
  })

  it('an all-skipped row is skipped and excluded with null score', () => {
    const row = scoreRow(
      'c6',
      [
        { field: 'structured', scorer: 'structured-diff', score: null, skipped: true },
        { field: 'prose', scorer: 'faithfulness', score: 1.0, zeroClaimFlag: true },
      ],
      THRESHOLDS,
    )
    expect(row.state).toBe('skipped')
    expect(row.score).toBeNull()
    expect(row.excluded).toBe(true)
  })

  it('rollUpRow on an empty field list is a skipped, excluded, null-score row', () => {
    const row = rollUpRow('c7', [])
    expect(row.state).toBe('skipped')
    expect(row.score).toBeNull()
    expect(row.excluded).toBe(true)
  })
})

describe('mixed rows feed scorer-agnostic agreement', () => {
  it('agreement works off generalized rows mixing diff and judge', () => {
    const outcomes: Array<{ id: string; intent: 'pass' | 'fail'; fields: FieldScoreOutcome[] }> = [
      // designed-pass, both fields strong -> matched (score 0.95) -> agree
      {
        id: 'p1',
        intent: 'pass',
        fields: [
          { field: 'structured', scorer: 'structured-diff', score: 1.0 },
          { field: 'prose', scorer: 'reference-judge', score: 0.9 },
        ],
      },
      // designed-fail, judge low -> mixed score below threshold -> agree
      {
        id: 'f1',
        intent: 'fail',
        fields: [
          { field: 'structured', scorer: 'structured-diff', score: 0.6 },
          { field: 'prose', scorer: 'reference-judge', score: 0.2 },
        ],
      },
      // judge-errored row -> excluded from the denominator
      {
        id: 'e1',
        intent: 'pass',
        fields: [{ field: 'prose', scorer: 'faithfulness', score: null, errored: true }],
      },
    ]

    const results = outcomes.map((o) =>
      toUserRunCaseResult(scoreRow(o.id, o.fields, THRESHOLDS), {
        intentLabel: o.intent,
        output: 'out',
        taskPrompt: 'prompt',
      }),
    )

    const agreement = computeUserAgreement(results, 0.85)
    expect(agreement.n).toBe(2) // e1 excluded
    expect(agreement.nExcluded).toBe(1)
    expect(agreement.agreeCount).toBe(2)
    expect(agreement.agreement).toBeCloseTo(1.0)
  })

  it('bridge: caseScore/caseExcluded read generalized fields when present', () => {
    const row = scoreRow(
      'm1',
      [{ field: 'structured', scorer: 'structured-diff', score: 0.4 }],
      THRESHOLDS,
    )
    const r = toUserRunCaseResult(row, { intentLabel: 'fail', output: 'o', taskPrompt: 't' })
    expect(caseScore(r)).toBeCloseTo(0.4)
    expect(caseExcluded(r)).toBe(false)
  })
})
