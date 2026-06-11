// @vitest-environment jsdom
//
// O7a / S22 / E27 — run round-trip WRITE PATH. Named to match the
// `pnpm test -- runmodel` verify filter.
//
// What this proves:
//   • regenerated outputs land in runs.current.outputs and survive a reload
//     (round-trip through localStorage via the v4 store),
//   • the E27 comparability fingerprint {genPromptHash, rubricHash, threshold,
//     scorerAssignments} is stamped per run, with genPromptHash stamped per output
//     and the run-level hash derived (single-valued, or '' when mixed),
//   • the S22 baseline-preservation invariant: an aborted / unscored regeneration
//     NEVER touches runs.previous — the scored baseline stays byte-identical and
//     delta-able.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  WORKBENCH_SET_ID,
  beginRun,
  writeOutput,
  deriveRunGenPromptHash,
  hashRubric,
  startRun,
  persistOutput,
  currentOutputs,
  currentFingerprint,
  NoActiveRunError,
  type StartRunOptions,
} from '../run-model'
import {
  genPromptHash,
  loadBenchStore,
  saveBenchSet,
  getBenchSet,
  exportBenchSet,
  type BenchSet,
  type BenchRun,
  type BenchRunOutput,
  type BenchCaseV4,
} from '@/lib/cases'

// ── fixtures ─────────────────────────────────────────────────────────────────

function benchCase(id: string): BenchCaseV4 {
  return {
    version: 4,
    id,
    taskPrompt: `prompt ${id}`,
    patientId: id,
    ragMode: 'stuff',
    fieldScorers: { claims: 'faithfulness' },
    createdAt: 0,
  }
}

function output(text: string, hash: string): BenchRunOutput {
  return { text, genPromptHash: hash, capturedGrounding: { mode: 'stuff', record: `rec:${text}` } }
}

// A fully-scored baseline run — what runs.previous holds (the delta-able baseline).
function scoredRun(genHash: string): BenchRun {
  return {
    genPromptHash: genHash,
    rubricHash: hashRubric('strict'),
    threshold: 0.85,
    scorerAssignments: { a: { claims: 'faithfulness' } },
    outputs: { a: output('baseline A', genHash) },
    scores: {
      a: {
        caseId: 'a',
        fields: [{ field: 'prose', scorer: 'faithfulness', score: 1, state: 'matched' }],
        score: 1,
        state: 'matched',
        excluded: false,
      },
    },
    timestamp: 1000,
  }
}

function startOpts(over: Partial<StartRunOptions> = {}): StartRunOptions {
  return {
    name: 'Workbench',
    cases: [benchCase('a'), benchCase('b')],
    rubricHash: hashRubric('strict'),
    threshold: 0.85,
    scorerAssignments: { a: { claims: 'faithfulness' }, b: { claims: 'faithfulness' } },
    timestamp: 2000,
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
})

// ── pure transforms ──────────────────────────────────────────────────────────

describe('beginRun (pure)', () => {
  const set: BenchSet = {
    id: 's',
    name: 's',
    createdAt: 0,
    cases: [benchCase('a')],
    labels: {},
    runs: { current: null, previous: scoredRun('PREV') },
  }

  it('stamps the full E27 fingerprint and starts empty outputs/scores', () => {
    const next = beginRun(set, {
      rubricHash: hashRubric('lenient'),
      threshold: 0.7,
      scorerAssignments: { a: { claims: 'faithfulness' } },
      timestamp: 42,
    })
    const cur = next.runs.current!
    expect(cur.rubricHash).toBe(hashRubric('lenient'))
    expect(cur.threshold).toBe(0.7)
    expect(cur.scorerAssignments).toEqual({ a: { claims: 'faithfulness' } })
    expect(cur.timestamp).toBe(42)
    expect(cur.outputs).toEqual({})
    expect(cur.scores).toEqual({})
    // run-level genPromptHash is undefined-until-derived → '' before any output
    expect(cur.genPromptHash).toBe('')
  })

  it('leaves runs.previous untouched (baseline preservation)', () => {
    const before = JSON.stringify(set.runs.previous)
    const next = beginRun(set, {
      rubricHash: 'r',
      threshold: 1,
      scorerAssignments: {},
      timestamp: 1,
    })
    expect(next.runs.previous).toBe(set.runs.previous) // same reference
    expect(JSON.stringify(set.runs.previous)).toBe(before) // input not mutated
  })
})

describe('writeOutput + deriveRunGenPromptHash (pure)', () => {
  it('throws when there is no active run', () => {
    const set: BenchSet = {
      id: 's',
      name: 's',
      createdAt: 0,
      cases: [],
      labels: {},
      runs: { current: null, previous: null },
    }
    expect(() => writeOutput(set, 'a', output('x', 'H'))).toThrow(NoActiveRunError)
  })

  it('stamps genPromptHash per output and derives a single-valued run hash', () => {
    let set = beginRun(
      { id: 's', name: 's', createdAt: 0, cases: [], labels: {}, runs: { current: null, previous: null } },
      { rubricHash: 'r', threshold: 1, scorerAssignments: {}, timestamp: 0 },
    )
    set = writeOutput(set, 'a', output('A', 'H1'))
    set = writeOutput(set, 'b', output('B', 'H1'))
    expect(set.runs.current!.outputs.a.genPromptHash).toBe('H1')
    expect(set.runs.current!.outputs.b.genPromptHash).toBe('H1')
    // all outputs share one hash → run-level hash is well-defined
    expect(set.runs.current!.genPromptHash).toBe('H1')
  })

  it('collapses the run-level hash to "" for a mixed-prompt run (S23)', () => {
    expect(deriveRunGenPromptHash({})).toBe('')
    expect(deriveRunGenPromptHash({ a: output('A', 'H1'), b: output('B', 'H2') })).toBe('')
    expect(deriveRunGenPromptHash({ a: output('A', 'H1'), b: output('B', 'H1') })).toBe('H1')
  })
})

// ── store round-trip (the reload-survival proof) ─────────────────────────────

describe('startRun → persistOutput → reload (store)', () => {
  it('persists each output into runs.current.outputs immediately (survives reload)', () => {
    startRun(WORKBENCH_SET_ID, startOpts())
    const h = genPromptHash('the gen prompt')
    persistOutput(WORKBENCH_SET_ID, 'a', output('answer A', h))

    // "Reload" = re-read the store from localStorage. The output is already there
    // — no end-of-run flush needed.
    const restored = currentOutputs(WORKBENCH_SET_ID)
    expect(restored.a.text).toBe('answer A')
    expect(restored.a.genPromptHash).toBe(h)
    expect(restored.a.capturedGrounding).toEqual({ mode: 'stuff', record: 'rec:answer A' })

    // A second output lands and is likewise immediately durable.
    persistOutput(WORKBENCH_SET_ID, 'b', output('answer B', h))
    const after = loadBenchStore().sets.find((s) => s.id === WORKBENCH_SET_ID)!.runs.current!
    expect(Object.keys(after.outputs).sort()).toEqual(['a', 'b'])
    expect(after.genPromptHash).toBe(h) // single shared prompt → well-defined
  })

  it('stamps the comparability fingerprint on the persisted run', () => {
    startRun(
      WORKBENCH_SET_ID,
      startOpts({ rubricHash: hashRubric('lenient'), threshold: 0.9 }),
    )
    const fp = currentFingerprint(WORKBENCH_SET_ID)!
    expect(fp.rubricHash).toBe(hashRubric('lenient'))
    expect(fp.threshold).toBe(0.9)
    expect(fp.scorerAssignments).toEqual({
      a: { claims: 'faithfulness' },
      b: { claims: 'faithfulness' },
    })
  })

  it('creates the set on first run and mirrors the cases', () => {
    expect(getBenchSet(WORKBENCH_SET_ID)).toBeUndefined()
    startRun(WORKBENCH_SET_ID, startOpts())
    const set = getBenchSet(WORKBENCH_SET_ID)!
    expect(set.name).toBe('Workbench')
    expect(set.cases.map((c) => c.id).sort()).toEqual(['a', 'b'])
  })

  it('persistOutput throws when no run was started', () => {
    expect(() => persistOutput(WORKBENCH_SET_ID, 'a', output('x', 'H'))).toThrow(NoActiveRunError)
  })
})

// ── baseline preservation across an aborted regeneration (S22) ───────────────

describe('aborted regeneration never touches runs.previous (S22)', () => {
  it('keeps runs.previous byte-identical and delta-able after a partial run', () => {
    // Seed a set that already has a fully-scored baseline in runs.previous.
    const baseline = scoredRun('BASE')
    const seeded: BenchSet = {
      id: WORKBENCH_SET_ID,
      name: 'Workbench',
      createdAt: 0,
      cases: [benchCase('a'), benchCase('b')],
      labels: {},
      runs: { current: null, previous: baseline },
    }
    saveBenchSet(seeded)
    const baselineJson = exportBenchSet(getBenchSet(WORKBENCH_SET_ID)!).match(/"previous".*/)
    const prevBefore = JSON.stringify(getBenchSet(WORKBENCH_SET_ID)!.runs.previous)

    // Start a NEW regeneration and persist only ONE of two cases, then "abort"
    // (simply stop persisting — the second case never lands).
    startRun(WORKBENCH_SET_ID, startOpts())
    persistOutput(WORKBENCH_SET_ID, 'a', output('partial A', genPromptHash('p')))

    const set = getBenchSet(WORKBENCH_SET_ID)!
    // current holds only the completed case...
    expect(Object.keys(set.runs.current!.outputs)).toEqual(['a'])
    // ...and the scored baseline is untouched — still fully scored, delta-able.
    expect(JSON.stringify(set.runs.previous)).toBe(prevBefore)
    expect(set.runs.previous).toEqual(baseline)
    expect(set.runs.previous!.scores.a.state).toBe('matched')
    expect(baselineJson).not.toBeNull()
  })

  it('a fresh startRun resets current.outputs but preserves the baseline', () => {
    const baseline = scoredRun('BASE')
    saveBenchSet({
      id: WORKBENCH_SET_ID,
      name: 'Workbench',
      createdAt: 0,
      cases: [benchCase('a')],
      labels: {},
      runs: { current: null, previous: baseline },
    })
    startRun(WORKBENCH_SET_ID, startOpts())
    persistOutput(WORKBENCH_SET_ID, 'a', output('A1', genPromptHash('p1')))
    // A second fresh start (e.g. user hits "Regenerate all" again) wipes current...
    startRun(WORKBENCH_SET_ID, startOpts())
    const set = getBenchSet(WORKBENCH_SET_ID)!
    expect(set.runs.current!.outputs).toEqual({})
    // ...but previous is still the original baseline.
    expect(set.runs.previous).toEqual(baseline)
  })
})
