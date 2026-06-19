import { describe, it, expect, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useNotebookCube } from '../useNotebookCube'
import { STORAGE_KEY, type ScoreRow, type NotebookState } from '@/lib/notebook/state'

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

// SHA-168 N16 — eval versioning. recordScore bumps the eval version on a
// content-hash change and stamps each row with the version it was graded under;
// a whitespace-only edit does not false-bump.
describe('useNotebookCube — eval versioning', () => {
  it('bumps the eval version on a criteria change and stamps each row', () => {
    const { result } = renderHook(() => useNotebookCube())

    act(() => {
      result.current.recordScore('run-1', { key: 'judge:j1', label: 'Judge', criteriaOrGolden: 'be grounded' }, ROW)
    })
    expect(result.current.state.evals.find((e) => e.key === 'judge:j1')?.version).toBe(1)
    expect(result.current.state.scores['judge:j1']['run-1'].evalVersion).toBe(1)

    // Revise the criteria, re-score a new run → version 2, history extends.
    act(() => {
      result.current.recordScore(
        'run-2',
        { key: 'judge:j1', label: 'Judge', criteriaOrGolden: 'be grounded in the context' },
        ROW,
      )
    })
    const def = result.current.state.evals.find((e) => e.key === 'judge:j1')
    expect(def?.version).toBe(2)
    expect(def?.history.map((h) => h.version)).toEqual([1, 2])
    // The new row stamps v2; the prior row keeps its v1 stamp (immutable).
    expect(result.current.state.scores['judge:j1']['run-2'].evalVersion).toBe(2)
    expect(result.current.state.scores['judge:j1']['run-1'].evalVersion).toBe(1)
  })

  it('does not bump on a whitespace-only criteria edit', () => {
    const { result } = renderHook(() => useNotebookCube())
    act(() => {
      result.current.recordScore('run-1', { key: 'golden', label: 'Golden', criteriaOrGolden: '{"a": 1}' }, ROW)
      result.current.recordScore('run-2', { key: 'golden', label: 'Golden', criteriaOrGolden: '{"a":   1}\n' }, ROW)
    })
    const def = result.current.state.evals.find((e) => e.key === 'golden')
    expect(def?.version).toBe(1)
    expect(def?.history).toHaveLength(1)
    expect(result.current.state.scores.golden['run-2'].evalVersion).toBe(1)
  })
})

// C6 / S35 — persistence. The cube auto-saves to localStorage and a fresh mount
// rehydrates it (reload survival); replaceState is the all-or-nothing import swap.
describe('useNotebookCube — persistence (C6/S35)', () => {
  beforeEach(() => localStorage.clear())

  it('saves the cube to localStorage and rehydrates on a fresh mount', async () => {
    const first = renderHook(() => useNotebookCube())
    act(() => {
      first.result.current.recordScore(
        'run-1',
        { key: 'golden', label: 'Golden set', criteriaOrGolden: '{}' },
        ROW,
      )
    })
    // The change is persisted under the notebook namespace…
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy())
    first.unmount()

    // …and a brand-new mount loads it back (the mount effect hydrates from storage).
    const second = renderHook(() => useNotebookCube())
    await waitFor(() =>
      expect(Object.keys(second.result.current.state.scores)).toEqual(['golden']),
    )
  })

  it('does not persist the empty pre-hydration state over a stored session', async () => {
    // Seed a stored session, then mount fresh: the first effect run must LOAD, not
    // overwrite with the initial empty cube.
    const seed = renderHook(() => useNotebookCube())
    act(() => {
      seed.result.current.recordScore(
        'run-1',
        { key: 'judge:j1', label: 'LLM judge', criteriaOrGolden: 'c' },
        ROW,
      )
    })
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBeTruthy())
    seed.unmount()

    const remount = renderHook(() => useNotebookCube())
    await waitFor(() =>
      expect(Object.keys(remount.result.current.state.scores)).toEqual(['judge:j1']),
    )
  })

  it('replaceState swaps the whole cube (import path)', () => {
    const { result } = renderHook(() => useNotebookCube())
    const imported: NotebookState = {
      ...result.current.state,
      scores: { golden: { 'run-1': ROW } },
    }
    act(() => {
      result.current.replaceState(imported)
    })
    expect(Object.keys(result.current.state.scores)).toEqual(['golden'])
  })
})
