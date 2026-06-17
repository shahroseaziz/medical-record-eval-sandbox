import { describe, it, expect } from 'vitest'
import { judgePassCalls, judgeCostLine, countJudgeable } from '../judgeCost'
import type { OutputCardResult } from '../useNotebookRun'

// SHA-167 N14 — the multi-judge cost preview is `judges × patients` metered calls,
// stated BEFORE the pass. These tests pin the arithmetic SCALING with judge count.

describe('judgePassCalls — judges × patients fan-out', () => {
  it('is patients for a single judge', () => {
    expect(judgePassCalls(1, 3)).toBe(3)
  })

  it('SCALES with judge count: 2 judges over 3 patients = 6 calls', () => {
    expect(judgePassCalls(2, 3)).toBe(6)
  })

  it('keeps scaling: 3 judges over 4 patients = 12 calls', () => {
    expect(judgePassCalls(3, 4)).toBe(12)
  })

  it('is zero when there are no patients or no judges', () => {
    expect(judgePassCalls(5, 0)).toBe(0)
    expect(judgePassCalls(0, 5)).toBe(0)
  })

  it('clamps negatives to a non-negative bill', () => {
    expect(judgePassCalls(-2, 3)).toBe(0)
    expect(judgePassCalls(2, -3)).toBe(0)
  })
})

describe('judgeCostLine — copy reflects the fan-out + the meter', () => {
  it('states the multiplication and the total, metered against the free tier', () => {
    const line = judgeCostLine(2, 3, false)
    expect(line).toContain('2 judges × 3 patients = 6 calls')
    expect(line).toContain('metered against the free tier')
  })

  it('a stored BYO key bills the caller, not the shared meter', () => {
    const line = judgeCostLine(2, 3, true)
    expect(line).toContain('6 calls')
    expect(line).toContain('billed to your key (not metered)')
  })

  it('singularizes one judge / one patient / one call', () => {
    expect(judgeCostLine(1, 1, false)).toContain('1 judge × 1 patient = 1 call')
  })
})

describe('countJudgeable — only patients with gradeable output cost a call', () => {
  function done(id: string, output: string): OutputCardResult {
    return { patientId: id, status: 'done', output, model: 'm', context: null }
  }

  it('counts only done, non-empty outputs in the run order', () => {
    const results: Record<string, OutputCardResult> = {
      p1: done('p1', '{"a":1}'),
      p2: done('p2', '   '), // empty after trim — not judgeable
      p3: { patientId: 'p3', status: 'pending', output: '', model: 'm', context: null },
    }
    expect(countJudgeable(['p1', 'p2', 'p3'], results)).toBe(1)
  })
})
