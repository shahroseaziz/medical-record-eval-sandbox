// @vitest-environment jsdom
//
// O9 / S22 / E26 — G5 user-label persistence. Named to match the
// `pnpm test -- agreement` verify filter.
//
// What this proves (label independence from runs, E26):
//   • a label write lands in BenchSet.labels and persists to localStorage,
//   • labels NEVER touch runs.current / runs.previous (orthogonal stores),
//   • labels survive a baseline-vs-current swap (rotation) and a regeneration —
//     the label set is the user's most durable asset after the authored set,
//   • clearing a label is also persisted and independent of runs.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  WORKBENCH_SET_ID,
  setLabel,
  unsetLabel,
  persistLabel,
  clearLabel,
  currentLabels,
  startRun,
  persistOutput,
  persistScore,
  hashRubric,
  type StartRunOptions,
} from '../run-model'
import {
  genPromptHash,
  getBenchSet,
  type BenchSet,
  type BenchRunOutput,
  type BenchCaseV4,
} from '@/lib/cases'
import type { RowResult } from '@/lib/eval/row-aggregate'

function benchCase(id: string): BenchCaseV4 {
  return {
    version: 4,
    id,
    taskPrompt: `prompt ${id}`,
    patientId: id,
    ragMode: 'stuff',
    fieldScorers: { prose: 'faithfulness' },
    createdAt: 0,
  }
}

function output(text: string, hash: string): BenchRunOutput {
  return { text, genPromptHash: hash, capturedGrounding: { mode: 'stuff', record: `rec:${text}` } }
}

function rowScore(caseId: string, score: number): RowResult {
  return {
    caseId,
    fields: [{ field: 'prose', scorer: 'faithfulness', score, state: 'matched' }],
    score,
    state: 'matched',
    excluded: false,
  }
}

function startOpts(cases: BenchCaseV4[], ts: number): StartRunOptions {
  return {
    name: 'Workbench',
    cases,
    rubricHash: hashRubric('strict'),
    threshold: 0.85,
    scorerAssignments: Object.fromEntries(
      cases.map((c) => [c.id, { prose: 'faithfulness' as const }]),
    ),
    timestamp: ts,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('setLabel / unsetLabel (pure — runs untouched)', () => {
  const base: BenchSet = {
    id: 's',
    name: 's',
    createdAt: 0,
    cases: [],
    labels: {},
    runs: { current: null, previous: null },
  }

  it('setLabel writes the label and threads runs through by reference', () => {
    const next = setLabel(base, 'a', 'pass')
    expect(next.labels).toEqual({ a: 'pass' })
    expect(next.runs).toBe(base.runs) // same reference — runs never perturbed
    expect(base.labels).toEqual({}) // input not mutated
  })

  it('unsetLabel removes the label and is a no-op when absent', () => {
    const labeled = setLabel(base, 'a', 'fail')
    const cleared = unsetLabel(labeled, 'a')
    expect(cleared.labels).toEqual({})
    expect(unsetLabel(base, 'missing')).toBe(base)
  })
})

describe('persistLabel / clearLabel / currentLabels (store edge)', () => {
  it('persists a label and rehydrates it from the store', () => {
    persistLabel(WORKBENCH_SET_ID, 'a', 'pass')
    expect(currentLabels(WORKBENCH_SET_ID)).toEqual({ a: 'pass' })
    persistLabel(WORKBENCH_SET_ID, 'b', 'fail')
    expect(currentLabels(WORKBENCH_SET_ID)).toEqual({ a: 'pass', b: 'fail' })
  })

  it('clearLabel removes one label, persisted', () => {
    persistLabel(WORKBENCH_SET_ID, 'a', 'pass')
    persistLabel(WORKBENCH_SET_ID, 'b', 'fail')
    clearLabel(WORKBENCH_SET_ID, 'a')
    expect(currentLabels(WORKBENCH_SET_ID)).toEqual({ b: 'fail' })
  })

  it('labels survive a baseline-vs-current swap (rotation) and a regeneration', () => {
    const cases = [benchCase('a'), benchCase('b')]
    // Label two outputs BEFORE any run exists.
    persistLabel(WORKBENCH_SET_ID, 'a', 'pass')
    persistLabel(WORKBENCH_SET_ID, 'b', 'fail')

    // Run 1: generate + fully score, so the next startRun rotates it into previous.
    startRun(WORKBENCH_SET_ID, startOpts(cases, 1000))
    for (const c of cases) {
      persistOutput(WORKBENCH_SET_ID, c.id, output(`out-${c.id}`, genPromptHash('p1')))
      persistScore(WORKBENCH_SET_ID, c.id, rowScore(c.id, 0.9))
    }

    // Run 2: regeneration rotates run 1 into the baseline (current→previous).
    startRun(WORKBENCH_SET_ID, startOpts(cases, 2000))

    const set = getBenchSet(WORKBENCH_SET_ID)!
    // Baseline rotated in; a fresh current opened — and the labels are untouched.
    expect(set.runs.previous).not.toBeNull()
    expect(set.runs.current).not.toBeNull()
    expect(set.labels).toEqual({ a: 'pass', b: 'fail' })
  })

  it('a label write does not disturb an in-flight run', () => {
    const cases = [benchCase('a')]
    startRun(WORKBENCH_SET_ID, startOpts(cases, 1000))
    persistOutput(WORKBENCH_SET_ID, 'a', output('out-a', genPromptHash('p1')))
    const before = getBenchSet(WORKBENCH_SET_ID)!.runs.current!.outputs

    persistLabel(WORKBENCH_SET_ID, 'a', 'pass')

    const after = getBenchSet(WORKBENCH_SET_ID)!.runs.current!.outputs
    expect(after).toEqual(before) // outputs unchanged by the label write
    expect(currentLabels(WORKBENCH_SET_ID)).toEqual({ a: 'pass' })
  })
})
