// O8 / E27 / design G3 — iteration delta semantics. Named to match the
// `pnpm test -- delta` verify filter.
//
// What this proves:
//   • per-case flips + aggregate move are computed over the cases scoreable in BOTH
//     runs (the honest n) — skipped / errored / absent cases never enter n,
//   • the gen-prompt axis ANNOTATES (a changed genPromptHash still renders the number),
//   • a mixed-prompt current run SUPPRESSES with the distinct "regenerate the full set"
//     banner — the one gen-prompt case that suppresses (S23),
//   • the rubric/threshold/scorer axis SUPPRESSES with the E27 comparability banner, and
//     the two axes are never conflated,
//   • structured-diff is threshold-invariant (a diff-only threshold move is NOT a divergence),
//   • copy is "k case(s) flipped (n=m)" and the ≥100-case floor tension is surfaced.
import { describe, it, expect } from 'vitest'
import {
  computeRunDelta,
  deltaAnnotation,
  floorCaveat,
  CASE_FLOOR,
  type RunDelta,
} from '../delta'
import type { BenchRun, BenchRunOutput, BenchFieldScorer } from '@/lib/cases'
import type { RowResult } from '@/lib/eval/row-aggregate'
import type { FieldResultState } from '@/lib/eval/types'

// ── fixtures ───────────────────────────────────────────────────────────────

function output(genHash: string): BenchRunOutput {
  return { text: 'out', genPromptHash: genHash, capturedGrounding: { mode: 'stuff', record: 'rec' } }
}

function row(caseId: string, state: FieldResultState): RowResult {
  const scoreable = state === 'matched' || state === 'mismatched'
  return {
    caseId,
    fields: [{ field: 'prose', scorer: 'faithfulness', score: state === 'matched' ? 1 : 0, state }],
    score: scoreable ? (state === 'matched' ? 1 : 0) : null,
    state,
    excluded: !scoreable,
  }
}

interface RunSpec {
  genHashes?: Record<string, string> // caseId → per-output gen hash
  rubricHash?: string
  threshold?: number
  scorer?: BenchFieldScorer
  scorerByCase?: Record<string, BenchFieldScorer>
  states: Record<string, FieldResultState> // caseId → row state
}

function run(spec: RunSpec): BenchRun {
  const caseIds = Object.keys(spec.states)
  const outputs: Record<string, BenchRunOutput> = {}
  const scores: Record<string, RowResult> = {}
  const scorerAssignments: Record<string, Record<string, BenchFieldScorer>> = {}
  for (const id of caseIds) {
    const hash = spec.genHashes?.[id] ?? 'hashA'
    outputs[id] = output(hash)
    scores[id] = row(id, spec.states[id])
    scorerAssignments[id] = { prose: spec.scorerByCase?.[id] ?? spec.scorer ?? 'faithfulness' }
  }
  const hashes = new Set(Object.values(outputs).map((o) => o.genPromptHash))
  return {
    genPromptHash: hashes.size === 1 ? [...hashes][0] : '',
    rubricHash: spec.rubricHash ?? 'rubric-v1',
    threshold: spec.threshold ?? 0.85,
    scorerAssignments,
    outputs,
    scores,
    timestamp: 0,
  }
}

// ── no baseline ──────────────────────────────────────────────────────────────

describe('computeRunDelta — no baseline', () => {
  it('returns no-baseline when previous is null', () => {
    const current = run({ states: { c1: 'matched' } })
    expect(computeRunDelta(null, current).status).toBe('no-baseline')
  })

  it('returns no-baseline when current is null', () => {
    const previous = run({ states: { c1: 'matched' } })
    expect(computeRunDelta(previous, null).status).toBe('no-baseline')
  })

  it('returns no-baseline when the current run has no scores yet', () => {
    const previous = run({ states: { c1: 'matched' } })
    const current = run({ states: { c1: 'matched' } })
    current.scores = {} // generated but not scored
    expect(computeRunDelta(previous, current).status).toBe('no-baseline')
  })
})

// ── happy path: flips + aggregate move + n ───────────────────────────────────

describe('computeRunDelta — comparable runs', () => {
  it('counts a single verdict flip with the honest n (G3 copy)', () => {
    const previous = run({ states: { c1: 'matched', c2: 'matched', c3: 'mismatched', c4: 'mismatched' } })
    const current = run({ states: { c1: 'matched', c2: 'matched', c3: 'matched', c4: 'mismatched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('ok')
    expect(d.n).toBe(4)
    expect(d.flips).toEqual([{ caseId: 'c3', from: 'fail', to: 'pass' }])
    expect(d.previousPass).toBe(2)
    expect(d.currentPass).toBe(3)
    expect(d.aggregateMove).toBeCloseTo(0.25)
    expect(d.copy).toBe('1 case flipped (n=4)')
  })

  it('pluralizes and counts multiple flips in both directions', () => {
    const previous = run({ states: { c1: 'matched', c2: 'mismatched', c3: 'matched' } })
    const current = run({ states: { c1: 'mismatched', c2: 'matched', c3: 'matched' } })
    const d = computeRunDelta(previous, current)
    expect(d.flips).toHaveLength(2)
    expect(d.copy).toBe('2 cases flipped (n=3)')
    expect(d.aggregateMove).toBeCloseTo(0) // one up, one down → net zero
  })

  it('reports zero flips honestly (no celebration)', () => {
    const previous = run({ states: { c1: 'matched', c2: 'mismatched' } })
    const current = run({ states: { c1: 'matched', c2: 'mismatched' } })
    const d = computeRunDelta(previous, current)
    expect(d.copy).toBe('0 cases flipped (n=2)')
    expect(d.aggregateMove).toBe(0)
  })

  it('excludes a case skipped/errored in EITHER run from n', () => {
    const previous = run({ states: { c1: 'matched', c2: 'matched', c3: 'skipped' } })
    const current = run({ states: { c1: 'mismatched', c2: 'judge-errored', c3: 'matched' } })
    const d = computeRunDelta(previous, current)
    // c1: comparable (flip). c2: errored in current → excluded. c3: skipped in previous → excluded.
    expect(d.n).toBe(1)
    expect(d.flips).toEqual([{ caseId: 'c1', from: 'pass', to: 'fail' }])
    expect(d.copy).toBe('1 case flipped (n=1)')
  })

  it('excludes a case present in only one run from n', () => {
    const previous = run({ states: { c1: 'matched' } })
    const current = run({ states: { c1: 'mismatched', c2: 'matched' } })
    const d = computeRunDelta(previous, current)
    expect(d.n).toBe(1) // only c1 is in both
  })
})

// ── gen-prompt axis: ANNOTATES, never suppresses (G3) ────────────────────────

describe('computeRunDelta — gen-prompt axis annotates', () => {
  it('still renders the number when genPromptHash differs across runs', () => {
    const previous = run({ genHashes: { c1: 'hashA' }, states: { c1: 'matched' } })
    const current = run({ genHashes: { c1: 'hashB' }, states: { c1: 'mismatched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('ok')
    expect(d.acrossPrompts).toBe(true)
    expect(d.copy).toBe('1 case flipped (n=1)')
    expect(deltaAnnotation(d)).toMatch(/different generation prompts/i)
  })

  it('does not annotate when both runs share a gen prompt', () => {
    const previous = run({ genHashes: { c1: 'hashA' }, states: { c1: 'matched' } })
    const current = run({ genHashes: { c1: 'hashA' }, states: { c1: 'matched' } })
    expect(deltaAnnotation(computeRunDelta(previous, current))).toBeNull()
  })
})

// ── mixed-prompt current run: SUPPRESSES (S23) ───────────────────────────────

describe('computeRunDelta — mixed-prompt current run suppresses', () => {
  it('suppresses with the distinct regenerate-the-full-set banner', () => {
    const previous = run({ genHashes: { c1: 'hashA', c2: 'hashA' }, states: { c1: 'matched', c2: 'matched' } })
    // c1 regenerated to hashB, c2 left at hashA → mixed-prompt current run.
    const current = run({ genHashes: { c1: 'hashB', c2: 'hashA' }, states: { c1: 'matched', c2: 'mismatched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('mixed-prompt')
    expect(d.banner).toMatch(/spans multiple generation prompts/i)
    expect(d.banner).toMatch(/regenerate the full set/i)
    expect(d.copy).toBe('') // no number
    expect(deltaAnnotation(d)).toBeNull()
  })
})

// ── rubric/threshold/scorer axis: SUPPRESSES (E27), never conflated ──────────

describe('computeRunDelta — comparability axis suppresses (E27)', () => {
  it('suppresses on a moved rubric', () => {
    const previous = run({ rubricHash: 'rubric-v1', states: { c1: 'matched' } })
    const current = run({ rubricHash: 'rubric-v2', states: { c1: 'mismatched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('incomparable')
    expect(d.divergedAxes).toEqual(['rubric'])
    expect(d.banner).toMatch(/judge rubric/i)
    expect(d.copy).toBe('')
  })

  it('suppresses on a moved threshold WHEN a judge is in play', () => {
    const previous = run({ threshold: 0.85, scorer: 'faithfulness', states: { c1: 'matched' } })
    const current = run({ threshold: 0.7, scorer: 'faithfulness', states: { c1: 'matched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('incomparable')
    expect(d.divergedAxes).toEqual(['threshold'])
  })

  it('does NOT suppress on a threshold move when both runs are structured-diff only (threshold-invariant)', () => {
    const previous = run({ threshold: 0.85, scorer: 'structured-diff', states: { c1: 'matched' } })
    const current = run({ threshold: 1.0, scorer: 'structured-diff', states: { c1: 'mismatched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('ok')
    expect(d.divergedAxes).toEqual([])
  })

  it('suppresses on a moved scorer assignment', () => {
    const previous = run({ scorerByCase: { c1: 'reference-judge' }, states: { c1: 'matched' } })
    const current = run({ scorerByCase: { c1: 'faithfulness' }, states: { c1: 'matched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('incomparable')
    expect(d.divergedAxes).toEqual(['scorer'])
  })

  it('lists every diverged axis in the banner', () => {
    const previous = run({ rubricHash: 'r1', threshold: 0.85, scorer: 'faithfulness', states: { c1: 'matched' } })
    const current = run({ rubricHash: 'r2', threshold: 0.7, scorer: 'faithfulness', states: { c1: 'matched' } })
    const d = computeRunDelta(previous, current)
    expect(d.divergedAxes).toEqual(['rubric', 'threshold'])
  })

  it('the comparability axis takes precedence over a mixed-prompt current run (axes never conflated)', () => {
    // Both a moved rubric AND a mixed-prompt current run — the E27 gate wins (primary gate).
    const previous = run({ rubricHash: 'r1', genHashes: { c1: 'hashA', c2: 'hashA' }, states: { c1: 'matched', c2: 'matched' } })
    const current = run({ rubricHash: 'r2', genHashes: { c1: 'hashB', c2: 'hashA' }, states: { c1: 'matched', c2: 'matched' } })
    const d = computeRunDelta(previous, current)
    expect(d.status).toBe('incomparable')
  })
})

// ── n-honesty: the ≥100-case floor tension is surfaced (G3) ──────────────────

describe('floorCaveat — n-honesty', () => {
  it('names the floor tension for a single-digit set', () => {
    const previous = run({ states: { c1: 'matched', c2: 'matched' } })
    const current = run({ states: { c1: 'mismatched', c2: 'matched' } })
    const d = computeRunDelta(previous, current)
    expect(d.belowFloor).toBe(true)
    const caveat = floorCaveat(d)
    expect(caveat).toMatch(new RegExp(`${CASE_FLOOR}-case floor`))
    expect(caveat).toMatch(/not proof/i)
  })

  it('returns no caveat for a suppressed delta', () => {
    const previous = run({ rubricHash: 'r1', states: { c1: 'matched' } })
    const current = run({ rubricHash: 'r2', states: { c1: 'matched' } })
    expect(floorCaveat(computeRunDelta(previous, current))).toBeNull()
  })

  it('does not flag belowFloor at or above the ≥100-case floor', () => {
    const states: Record<string, FieldResultState> = {}
    for (let i = 0; i < CASE_FLOOR; i++) states[`c${i}`] = 'matched'
    const d: RunDelta = computeRunDelta(run({ states }), run({ states }))
    expect(d.n).toBe(CASE_FLOOR)
    expect(d.belowFloor).toBe(false)
    expect(floorCaveat(d)).toBeNull()
  })
})
