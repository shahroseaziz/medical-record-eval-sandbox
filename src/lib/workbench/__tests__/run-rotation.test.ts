// @vitest-environment jsdom
//
// O7b / S22 — run round-trip SCORING + ROTATION. Named to match the
// `pnpm test -- rotation` verify filter.
//
// What this proves (the run-slot lifecycle, S22):
//   • scoring writes runs.current.scores and NEVER touches runs.previous,
//   • `isScoringComplete` is true only when EVERY persisted output carries a score,
//   • rotation promotes current→previous ONLY when scoring is complete — a partial /
//     unscored current is never promoted, so the baseline is never lost,
//   • the next regeneration (startRun) rotates a completed run into the baseline and
//     leaves a partial one in place — both preserving runs.previous.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  WORKBENCH_SET_ID,
  writeScore,
  isScoringComplete,
  rotateCompletedRun,
  hashRubric,
  startRun,
  persistOutput,
  persistScore,
  currentScores,
  isCurrentScoringComplete,
  NoActiveRunError,
  type StartRunOptions,
} from '../run-model'
import {
  genPromptHash,
  getBenchSet,
  saveBenchSet,
  type BenchSet,
  type BenchRun,
  type BenchRunOutput,
  type BenchCaseV4,
} from '@/lib/cases'
import type { RowResult } from '@/lib/eval/row-aggregate'

// ── fixtures ─────────────────────────────────────────────────────────────────

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

function emptyRun(genHash = ''): BenchRun {
  return {
    genPromptHash: genHash,
    rubricHash: hashRubric('strict'),
    threshold: 0.85,
    scorerAssignments: {},
    outputs: {},
    scores: {},
    timestamp: 1000,
  }
}

function setWithCurrent(current: BenchRun | null, previous: BenchRun | null): BenchSet {
  return {
    id: WORKBENCH_SET_ID,
    name: 'Workbench',
    createdAt: 0,
    cases: [benchCase('a'), benchCase('b')],
    labels: {},
    runs: { current, previous },
  }
}

function startOpts(over: Partial<StartRunOptions> = {}): StartRunOptions {
  return {
    name: 'Workbench',
    cases: [benchCase('a'), benchCase('b')],
    rubricHash: hashRubric('strict'),
    threshold: 0.85,
    scorerAssignments: { a: { prose: 'faithfulness' }, b: { prose: 'faithfulness' } },
    timestamp: 2000,
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
})

// ── writeScore (pure) ────────────────────────────────────────────────────────

describe('writeScore (pure)', () => {
  it('throws when there is no active run', () => {
    expect(() => writeScore(setWithCurrent(null, null), 'a', rowScore('a', 1))).toThrow(
      NoActiveRunError,
    )
  })

  it('writes into runs.current.scores and threads runs.previous untouched', () => {
    const prev = { ...emptyRun('PREV'), outputs: { a: output('p', 'PREV') }, scores: { a: rowScore('a', 1) } }
    let set = setWithCurrent({ ...emptyRun(), outputs: { a: output('A', 'H') } }, prev)
    set = writeScore(set, 'a', rowScore('a', 0.9))
    expect(set.runs.current!.scores.a.score).toBe(0.9)
    // baseline preserved by reference (never touched by scoring)
    expect(set.runs.previous).toBe(prev)
  })
})

// ── isScoringComplete (pure) ───────────────────────────────────────────────────

describe('isScoringComplete (pure)', () => {
  it('is false for an empty run (nothing generated → no baseline to rotate)', () => {
    expect(isScoringComplete(emptyRun())).toBe(false)
  })

  it('is false when SOME outputs are unscored (a partial pass)', () => {
    const run: BenchRun = {
      ...emptyRun(),
      outputs: { a: output('A', 'H'), b: output('B', 'H') },
      scores: { a: rowScore('a', 1) },
    }
    expect(isScoringComplete(run)).toBe(false)
  })

  it('is true only when EVERY output carries a score', () => {
    const run: BenchRun = {
      ...emptyRun(),
      outputs: { a: output('A', 'H'), b: output('B', 'H') },
      scores: { a: rowScore('a', 1), b: rowScore('b', 0.8) },
    }
    expect(isScoringComplete(run)).toBe(true)
  })
})

// ── rotateCompletedRun (pure) — the rotation gate ──────────────────────────────

describe('rotateCompletedRun (pure)', () => {
  it('rotates a COMPLETED run into previous and clears current', () => {
    const complete: BenchRun = {
      ...emptyRun('GEN'),
      outputs: { a: output('A', 'GEN'), b: output('B', 'GEN') },
      scores: { a: rowScore('a', 1), b: rowScore('b', 0.9) },
    }
    const baseline = emptyRun('OLD')
    const next = rotateCompletedRun(setWithCurrent(complete, baseline))
    expect(next.runs.current).toBeNull()
    expect(next.runs.previous).toBe(complete) // completed run is the new baseline
  })

  it('does NOT rotate a PARTIAL run — baseline preserved, current left in place', () => {
    const partial: BenchRun = {
      ...emptyRun('GEN'),
      outputs: { a: output('A', 'GEN'), b: output('B', 'GEN') },
      scores: { a: rowScore('a', 1) }, // b unscored
    }
    const baseline = emptyRun('OLD')
    const before = setWithCurrent(partial, baseline)
    const next = rotateCompletedRun(before)
    expect(next).toBe(before) // unchanged reference — no rotation
    expect(next.runs.current).toBe(partial)
    expect(next.runs.previous).toBe(baseline)
  })

  it('does NOT rotate an empty / null current', () => {
    const baseline = emptyRun('OLD')
    expect(rotateCompletedRun(setWithCurrent(emptyRun(), baseline)).runs.previous).toBe(baseline)
    expect(rotateCompletedRun(setWithCurrent(null, baseline)).runs.previous).toBe(baseline)
  })
})

// ── store round-trip: score → persist → resume ─────────────────────────────────

describe('persistScore → currentScores (store)', () => {
  it('persists each row score immediately (survives reload)', () => {
    startRun(WORKBENCH_SET_ID, startOpts())
    const h = genPromptHash('p')
    persistOutput(WORKBENCH_SET_ID, 'a', output('A', h))
    persistOutput(WORKBENCH_SET_ID, 'b', output('B', h))

    persistScore(WORKBENCH_SET_ID, 'a', rowScore('a', 1))
    expect(Object.keys(currentScores(WORKBENCH_SET_ID))).toEqual(['a'])
    // partial pass → not complete yet
    expect(isCurrentScoringComplete(WORKBENCH_SET_ID)).toBe(false)

    persistScore(WORKBENCH_SET_ID, 'b', rowScore('b', 0.9))
    expect(isCurrentScoringComplete(WORKBENCH_SET_ID)).toBe(true)
    // re-read from localStorage proves durability
    const reloaded = getBenchSet(WORKBENCH_SET_ID)!.runs.current!
    expect(Object.keys(reloaded.scores).sort()).toEqual(['a', 'b'])
  })

  it('persistScore throws when no run is active', () => {
    expect(() => persistScore(WORKBENCH_SET_ID, 'a', rowScore('a', 1))).toThrow(NoActiveRunError)
  })
})

// ── rotation only on completed scoring, through startRun ───────────────────────

describe('next regeneration rotates ONLY a completed run (S22)', () => {
  it('a completed scoring pass rotates current→previous before the next regeneration', () => {
    // Generate + fully score a run.
    startRun(WORKBENCH_SET_ID, startOpts())
    const h1 = genPromptHash('p1')
    persistOutput(WORKBENCH_SET_ID, 'a', output('A1', h1))
    persistOutput(WORKBENCH_SET_ID, 'b', output('B1', h1))
    persistScore(WORKBENCH_SET_ID, 'a', rowScore('a', 1))
    persistScore(WORKBENCH_SET_ID, 'b', rowScore('b', 1))
    const completed = getBenchSet(WORKBENCH_SET_ID)!.runs.current!

    // Next regeneration: the completed run becomes the baseline; current is fresh.
    startRun(WORKBENCH_SET_ID, startOpts({ timestamp: 3000 }))
    const set = getBenchSet(WORKBENCH_SET_ID)!
    expect(set.runs.current!.outputs).toEqual({})
    expect(set.runs.current!.scores).toEqual({})
    expect(set.runs.previous!.outputs).toEqual(completed.outputs)
    expect(set.runs.previous!.scores).toEqual(completed.scores)
  })

  it('a PARTIAL scoring pass does NOT rotate — the prior baseline survives', () => {
    // Seed a fully-scored baseline directly in runs.previous.
    const baseline: BenchRun = {
      ...emptyRun('BASE'),
      outputs: { a: output('base A', 'BASE') },
      scores: { a: rowScore('a', 1) },
    }
    saveBenchSet(setWithCurrent(null, baseline))

    // Generate two, score only one (partial), then regenerate.
    startRun(WORKBENCH_SET_ID, startOpts())
    const h = genPromptHash('p')
    persistOutput(WORKBENCH_SET_ID, 'a', output('A', h))
    persistOutput(WORKBENCH_SET_ID, 'b', output('B', h))
    persistScore(WORKBENCH_SET_ID, 'a', rowScore('a', 1)) // only a — partial

    startRun(WORKBENCH_SET_ID, startOpts({ timestamp: 3000 }))
    const set = getBenchSet(WORKBENCH_SET_ID)!
    // The partial run was NOT promoted; the original baseline is intact.
    expect(set.runs.previous!.genPromptHash).toBe('BASE')
    expect(set.runs.previous!.scores.a.score).toBe(1)
    expect(set.runs.current!.outputs).toEqual({})
  })
})
