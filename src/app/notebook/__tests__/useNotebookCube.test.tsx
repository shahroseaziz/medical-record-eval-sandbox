import { describe, it, expect } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useNotebookCube } from '../useNotebookCube'
import type { ScoreRow } from '@/lib/notebook/state'

// SHA-167 N14 collateral — removing a judge cell must clean ITS scores from the
// cube (and its eval definition), leaving the singular golden and other judges
// untouched. A removed judge leaves no trace in state or in an export.

const ROW: ScoreRow = { frac: '1/1', per: [{ patientId: 'p1', state: 'pass', fails: [] }] }

describe('useNotebookCube — removeScore', () => {
  it('drops a judge eval column AND its definition, keeping the golden + other judges', () => {
    const { result } = renderHook(() => useNotebookCube())

    act(() => {
      result.current.recordScore('run-1', { key: 'golden', label: 'Golden set', criteriaOrGolden: '{}' }, ROW)
      result.current.recordScore('run-1', { key: 'judge:j2', label: 'LLM judge 2', criteriaOrGolden: 'c2' }, ROW)
      result.current.recordScore('run-1', { key: 'judge:j3', label: 'LLM judge 3', criteriaOrGolden: 'c3' }, ROW)
    })

    expect(Object.keys(result.current.state.scores).sort()).toEqual(['golden', 'judge:j2', 'judge:j3'])
    expect(result.current.state.evals.map((e) => e.key).sort()).toEqual(['golden', 'judge:j2', 'judge:j3'])

    act(() => {
      result.current.removeScore('judge:j2')
    })

    // j2 is gone from BOTH scores and evals; golden + j3 remain.
    expect(result.current.state.scores['judge:j2']).toBeUndefined()
    expect(result.current.state.evals.find((e) => e.key === 'judge:j2')).toBeUndefined()
    expect(Object.keys(result.current.state.scores).sort()).toEqual(['golden', 'judge:j3'])
    expect(result.current.state.scores.golden).toBeDefined()
  })

  it('is a no-op for an eval that was never scored', () => {
    const { result } = renderHook(() => useNotebookCube())
    const before = result.current.state
    act(() => {
      result.current.removeScore('judge:nope')
    })
    // Same object identity → state untouched.
    expect(result.current.state).toBe(before)
  })
})
