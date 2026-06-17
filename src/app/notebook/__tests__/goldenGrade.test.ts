import { describe, it, expect } from 'vitest'
import { gradeGolden, parseJsonObject } from '../goldenGrade'

// Deterministic golden grading (SHA-161 N9). Every verdict is computed purely
// from local strings through lib/eval/normalize — no I/O, no network.

describe('parseJsonObject', () => {
  it('parses a plain JSON object', () => {
    expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 })
  })

  it('returns null for empty / non-object text', () => {
    expect(parseJsonObject('')).toBeNull()
    expect(parseJsonObject('   ')).toBeNull()
    expect(parseJsonObject('[1, 2]')).toBeNull()
    expect(parseJsonObject('not json')).toBeNull()
  })

  it('unwraps a ```json fenced object (model output)', () => {
    expect(parseJsonObject('```json\n{"a1c_current": 6.7}\n```')).toEqual({ a1c_current: 6.7 })
  })

  it('recovers an object embedded in surrounding prose', () => {
    expect(parseJsonObject('Here you go: {"a": "b"} hope that helps')).toEqual({ a: 'b' })
  })
})

describe('gradeGolden', () => {
  const out = JSON.stringify({
    a1c_current: 6.7,
    a1c_trend: 'improving',
    diabetes_meds: ['Metformin', 'Glipizide'],
  })

  it('is empty when the golden is blank', () => {
    expect(gradeGolden('', out, true).state).toBe('empty')
    expect(gradeGolden('   ', out, true).state).toBe('empty')
  })

  it('is invalid (not graded) when the golden is not JSON', () => {
    const g = gradeGolden('a1c is 6.7', out, true)
    expect(g.state).toBe('invalid')
    expect(g.error).toBeTruthy()
  })

  it('reports nooutput before the patient has run', () => {
    expect(gradeGolden('{"a1c_current": 6.7}', undefined, false).state).toBe('nooutput')
    expect(gradeGolden('{"a1c_current": 6.7}', '', false).state).toBe('nooutput')
  })

  it('passes when every golden field matches after normalization', () => {
    const golden = JSON.stringify({ a1c_current: 6.7, a1c_trend: 'improving' })
    expect(gradeGolden(golden, out, true).state).toBe('pass')
  })

  it('grades partially — fields ABSENT from the golden are not graded', () => {
    // Golden only asserts a1c_current; the model's (wrong-by-omission) trend is
    // irrelevant because the golden never mentions it.
    const golden = JSON.stringify({ a1c_current: 6.7 })
    const g = gradeGolden(golden, out, true)
    expect(g.state).toBe('pass')
    expect(g.fields.map((f) => f.field)).toEqual(['a1c_current'])
  })

  it('folds list order, casing, and clinical aliases via normalize.ts', () => {
    // Golden lists meds in a different order with a SIG alias; model uses longhand.
    const model = JSON.stringify({
      frequency: 'once daily',
      diabetes_meds: ['glipizide', 'metformin'],
    })
    const golden = JSON.stringify({ frequency: 'QD', diabetes_meds: ['Metformin', 'Glipizide'] })
    expect(gradeGolden(golden, model, true).state).toBe('pass')
  })

  it('fails and surfaces an expected-vs-got diff for each mismatch', () => {
    const golden = JSON.stringify({ a1c_current: 5.9, a1c_trend: 'worsening' })
    const g = gradeGolden(golden, out, true)
    expect(g.state).toBe('fail')
    expect(g.fails.map((f) => f.field).sort()).toEqual(['a1c_current', 'a1c_trend'])
    const a1c = g.fails.find((f) => f.field === 'a1c_current')!
    expect(a1c.expected).toBe('5.9')
    expect(a1c.got).toBe('6.7')
  })

  it('fails a golden field the model omitted entirely (got = "—")', () => {
    const golden = JSON.stringify({ a1c_current: 6.7, weight_kg: 80 })
    const g = gradeGolden(golden, out, true)
    expect(g.state).toBe('fail')
    const weight = g.fails.find((f) => f.field === 'weight_kg')!
    expect(weight.got).toBe('—')
  })
})
