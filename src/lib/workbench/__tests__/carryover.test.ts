import { describe, it, expect } from 'vitest'
import {
  encodeCarryParams,
  decodeCarryParams,
  benchHrefFromLesson,
  CARRY_SOURCE,
  type LessonCarryState,
} from '../carryover'

/**
 * R12 — the lesson → bench carry-over seam. Encoding must be total and decoding
 * must be defensive: the query string is untrusted input (rule 18), so anything
 * outside the known domain is dropped, never trusted.
 */
describe('carryover (lesson → workbench state)', () => {
  const state: LessonCarryState = {
    evaluator: 'faithfulness',
    rubric: 'lenient',
    labels: { 'beat3-medications-pass': 'fail', 'beat3-allergies-rubric-sensitive-fail': 'pass' },
  }

  it('round-trips evaluator, rubric, and labels', () => {
    const decoded = decodeCarryParams(Object.fromEntries(new URLSearchParams(encodeCarryParams(state))))
    expect(decoded.fromLesson).toBe(true)
    expect(decoded.evaluator).toBe('faithfulness')
    expect(decoded.rubric).toBe('lenient')
    expect(decoded.labels).toEqual(state.labels)
  })

  it('marks the source so the bench knows it came from the lesson', () => {
    expect(encodeCarryParams(state)).toContain(`from=${CARRY_SOURCE}`)
    expect(decodeCarryParams({ from: CARRY_SOURCE }).fromLesson).toBe(true)
    expect(decodeCarryParams({}).fromLesson).toBe(false)
  })

  it('benchHrefFromLesson builds a /workbench link carrying the state', () => {
    const href = benchHrefFromLesson(state)
    expect(href.startsWith('/workbench?')).toBe(true)
    const decoded = decodeCarryParams(
      Object.fromEntries(new URLSearchParams(href.split('?')[1])),
    )
    expect(decoded.rubric).toBe('lenient')
    expect(decoded.labels['beat3-medications-pass']).toBe('fail')
  })

  it('drops an unknown evaluator and rubric rather than trusting them (rule 18)', () => {
    const decoded = decodeCarryParams({ evaluator: 'rm-rf', rubric: 'permissive' })
    expect(decoded.evaluator).toBeUndefined()
    expect(decoded.rubric).toBeUndefined()
  })

  it('skips malformed or out-of-domain label pairs', () => {
    const decoded = decodeCarryParams({
      labels: 'beat3-medications-pass:fail,bad pair,weird-id:maybe,injected key:pass',
    })
    expect(decoded.labels).toEqual({ 'beat3-medications-pass': 'fail' })
  })

  it('omits the labels param entirely when nothing was relabeled', () => {
    const encoded = encodeCarryParams({ evaluator: 'faithfulness', rubric: 'strict', labels: {} })
    expect(encoded).not.toContain('labels=')
    expect(decodeCarryParams(Object.fromEntries(new URLSearchParams(encoded))).labels).toEqual({})
  })

  it('handles array-valued params (Next can pass repeated keys) by taking the first', () => {
    const decoded = decodeCarryParams({
      from: ['lesson', 'spoof'],
      rubric: ['strict', 'lenient'],
    })
    expect(decoded.fromLesson).toBe(true)
    expect(decoded.rubric).toBe('strict')
  })
})
