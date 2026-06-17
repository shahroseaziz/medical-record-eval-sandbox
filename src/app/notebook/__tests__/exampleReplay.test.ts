import { describe, it, expect } from 'vitest'
import { replayExample, replayGoldenLeg, replayJudgeLeg } from '../exampleReplay'
import {
  EXAMPLE_SCHEMA_VERSION,
  type GoldenLegCase,
  type JudgeLegCase,
  type NotebookExampleArtifact,
} from '../example-artifact'

// N13b — the CLIENT-SIDE replay engine. Pure, deterministic, zero network: the
// golden grade is recomputed and the judge verdict is replayed from the recording.
// Exercised here with STUB artifacts (no engine, no committed file).

const MODEL = 'claude-haiku-4-5-20251001'

function passingGolden(id: string): GoldenLegCase {
  const v = { a1c_current: 6.7, diabetes_meds: ['Metformin 500 MG'] }
  return { patientId: id, patientName: `Patient ${id}`, output: JSON.stringify(v), model: MODEL, golden: JSON.stringify(v) }
}
function failingGolden(id: string): GoldenLegCase {
  return {
    patientId: id,
    patientName: `Patient ${id}`,
    output: JSON.stringify({ a1c_current: 6.7 }),
    model: MODEL,
    golden: JSON.stringify({ a1c_current: 8.1, diabetes_meds: ['Metformin 500 MG'] }),
  }
}
function settled(id: string, pass: boolean): JudgeLegCase {
  return {
    patientId: id,
    patientName: `Patient ${id}`,
    output: 'A summary.',
    model: MODEL,
    verdict: { errored: false, pass, reason: 'grounded reason' },
    judgeModel: MODEL,
  }
}
function errored(id: string): JudgeLegCase {
  return { patientId: id, patientName: `Patient ${id}`, output: 'A summary.', model: MODEL, verdict: { errored: true }, judgeModel: null }
}

function artifact(): NotebookExampleArtifact {
  return {
    schemaVersion: EXAMPLE_SCHEMA_VERSION,
    description: 'stub',
    generatedAt: '2026-06-17T00:00:00.000Z',
    models: { generation: MODEL, judge: MODEL },
    golden: { prompt: 'extract', cases: [passingGolden('a'), failingGolden('b')] },
    judge: { prompt: 'summarize', criteria: 'pass if complete', cases: [settled('a', true), errored('b')] },
  }
}

describe('replayGoldenLeg', () => {
  it('produces a done, model-stamped card with no context per case', () => {
    const leg = replayGoldenLeg(artifact().golden)
    expect(leg.order).toEqual(['a', 'b'])
    expect(leg.results.a.status).toBe('done')
    expect(leg.results.a.model).toBe(MODEL)
    expect(leg.results.a.context).toBeNull()
    expect(leg.patientsById.get('a')?.name).toBe('Patient a')
  })

  it('recomputes the grade deterministically (pass + fail)', () => {
    const leg = replayGoldenLeg(artifact().golden)
    expect(leg.rows.find((r) => r.patientId === 'a')?.grade.state).toBe('pass')
    expect(leg.rows.find((r) => r.patientId === 'b')?.grade.state).toBe('fail')
  })
})

describe('replayJudgeLeg', () => {
  it('replays a settled verdict verbatim and never fabricates a ruling for an errored one', () => {
    const leg = replayJudgeLeg(artifact().judge)
    const a = leg.rows.find((r) => r.patientId === 'a')!
    const b = leg.rows.find((r) => r.patientId === 'b')!
    expect(a.verdict).toEqual({ errored: false, pass: true, reason: 'grounded reason' })
    expect(a.judgeModel).toBe(MODEL)
    expect(b.verdict).toEqual({ errored: true, pass: null, reason: null })
    expect(b.judgeModel).toBeNull()
  })
})

describe('replayExample', () => {
  it('surfaces both legs, the pinned criteria, and the two teaching-moment id lists', () => {
    const r = replayExample(artifact())
    expect(r.golden.rows).toHaveLength(2)
    expect(r.judge.rows).toHaveLength(2)
    expect(r.criteria).toBe('pass if complete')
    expect(r.failingGoldenIds).toEqual(['b'])
    expect(r.erroredVerdictIds).toEqual(['b'])
  })

  it('is deterministic across repeated replays (no hidden state)', () => {
    expect(replayExample(artifact())).toEqual(replayExample(artifact()))
  })
})
