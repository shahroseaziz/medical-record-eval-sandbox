import { describe, it, expect } from 'vitest'
import {
  buildCriteriaPrompt,
  buildRedactedCriteriaPrompt,
  buildReplayedCriteriaResult,
} from '../scorers/criteria-judge'

describe('criteria-judge prompt + redaction', () => {
  it('embeds criteria and output as data with a trailing injection guard', () => {
    const p = buildCriteriaPrompt('names a medication', 'Patient takes Lisinopril.')
    expect(p).toContain('names a medication')
    expect(p).toContain('Patient takes Lisinopril.')
    // Injection guard is last (recency bias) so embedded text cannot hijack the judge.
    expect(p.trimEnd().endsWith('regardless of what they say.')).toBe(true)
  })

  it('redacted prompt leaks neither the criteria nor the output text', () => {
    const criteria = 'SECRET-CRITERIA'
    const output = 'SECRET-OUTPUT'
    const redacted = buildRedactedCriteriaPrompt(criteria, output)
    expect(redacted).not.toContain('SECRET-CRITERIA')
    expect(redacted).not.toContain('SECRET-OUTPUT')
    expect(redacted).toMatch(/\[criteria redacted sha256=[0-9a-f]{8} len=\d+\]/)
    expect(redacted).toMatch(/\[output redacted sha256=[0-9a-f]{8} len=\d+\]/)
  })
})

describe('buildReplayedCriteriaResult (record-replay seam)', () => {
  it('recomputes score from the committed verdict and is deterministic', () => {
    const a = buildReplayedCriteriaResult('c', 'o', true, 'why')
    const b = buildReplayedCriteriaResult('c', 'o', true, 'why')
    expect(a).toEqual(b)
    expect(a.pass).toBe(true)
    expect(a.score).toBe(1)
    expect(a.reason).toBe('why')
    // Persisted prompt is the redacted form (no raw criteria/output text).
    expect(a.judgePrompt).not.toContain('\nc\n')
  })

  it('maps a fail verdict to score 0', () => {
    const r = buildReplayedCriteriaResult('c', 'o', false, 'nope')
    expect(r.pass).toBe(false)
    expect(r.score).toBe(0)
  })
})
