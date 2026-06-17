import { describe, it, expect } from 'vitest'
import {
  assertTeachingConditions,
  failingGoldenCases,
  erroredVerdicts,
  replayGoldenGrade,
  replayJudgeVerdict,
  serializeArtifact,
  EmptyGoldenLegError,
  EmptyJudgeLegError,
  MissingFailingGoldenError,
  MissingErroredVerdictError,
  EXAMPLE_SCHEMA_VERSION,
  type GoldenLegCase,
  type JudgeLegCase,
  type NotebookExampleArtifact,
} from '../example-artifact'

// N13a — the worked-example artifact contract + teaching-condition guard. These
// exercise the two ERROR paths the generator must enforce, plus the deterministic
// CLIENT-SIDE replay, with STUB inputs (no engine, no network).

const MODEL = 'claude-haiku-4-5-20251001'

// A golden whose output matches → PASSES.
function passingGolden(patientId: string): GoldenLegCase {
  const value = { a1c_current: 6.7, diabetes_meds: ['Metformin 500 MG'] }
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: JSON.stringify(value),
    model: MODEL,
    golden: JSON.stringify(value),
  }
}

// A golden whose output drops a required field → FAILS.
function failingGolden(patientId: string): GoldenLegCase {
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: JSON.stringify({ a1c_current: 6.7 }),
    model: MODEL,
    golden: JSON.stringify({ a1c_current: 8.1, diabetes_meds: ['Metformin 500 MG'] }),
  }
}

function settledVerdict(patientId: string, pass: boolean): JudgeLegCase {
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: 'A written summary of the chart.',
    model: MODEL,
    verdict: { errored: false, pass, reason: 'Grounded in the criteria and the output.' },
    judgeModel: MODEL,
  }
}

function erroredVerdict(patientId: string): JudgeLegCase {
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: 'A written summary of the chart.',
    model: MODEL,
    verdict: { errored: true },
    judgeModel: null,
  }
}

function artifact(golden: GoldenLegCase[], judge: JudgeLegCase[]): NotebookExampleArtifact {
  return {
    schemaVersion: EXAMPLE_SCHEMA_VERSION,
    description: 'stub',
    generatedAt: '2026-06-17T00:00:00.000Z',
    models: { generation: MODEL, judge: MODEL },
    golden: { prompt: 'extract diabetes management', cases: golden },
    judge: { prompt: 'summarize the chart', criteria: 'pass if complete', cases: judge },
  }
}

describe('replayGoldenGrade (deterministic, zero metered calls)', () => {
  it('grades a matching output as pass and a dropped-field output as fail', () => {
    expect(replayGoldenGrade(passingGolden('p1')).state).toBe('pass')
    expect(replayGoldenGrade(failingGolden('p2')).state).toBe('fail')
  })

  it('is deterministic across repeated calls', () => {
    const c = failingGolden('p3')
    expect(replayGoldenGrade(c)).toEqual(replayGoldenGrade(c))
  })

  it('failingGoldenCases finds exactly the failing rows', () => {
    const leg = { prompt: 'x', cases: [passingGolden('a'), failingGolden('b'), passingGolden('c')] }
    expect(failingGoldenCases(leg).map((c) => c.patientId)).toEqual(['b'])
  })
})

describe('replayJudgeVerdict (recorded, zero metered calls)', () => {
  it('replays a settled verdict verbatim', () => {
    expect(replayJudgeVerdict(settledVerdict('p1', true))).toEqual({
      errored: false,
      pass: true,
      reason: 'Grounded in the criteria and the output.',
    })
  })

  it('never fabricates a ruling for an errored verdict', () => {
    expect(replayJudgeVerdict(erroredVerdict('p2'))).toEqual({
      errored: true,
      pass: null,
      reason: null,
    })
  })

  it('erroredVerdicts finds exactly the errored rows', () => {
    const leg = {
      prompt: 'x',
      criteria: 'y',
      cases: [settledVerdict('a', true), erroredVerdict('b'), settledVerdict('c', false)],
    }
    expect(erroredVerdicts(leg).map((c) => c.patientId)).toEqual(['b'])
  })
})

describe('assertTeachingConditions', () => {
  it('passes when both teaching moments are present', () => {
    const a = artifact(
      [passingGolden('a'), failingGolden('b')],
      [settledVerdict('a', true), erroredVerdict('b')],
    )
    expect(() => assertTeachingConditions(a)).not.toThrow()
  })

  it('throws MissingFailingGoldenError when every golden passes', () => {
    const a = artifact(
      [passingGolden('a'), passingGolden('b')],
      [settledVerdict('a', true), erroredVerdict('b')],
    )
    expect(() => assertTeachingConditions(a)).toThrow(MissingFailingGoldenError)
    expect(() => assertTeachingConditions(a)).toThrow(/every golden row PASSES/)
  })

  it('throws MissingErroredVerdictError when no verdict errored', () => {
    const a = artifact(
      [passingGolden('a'), failingGolden('b')],
      [settledVerdict('a', true), settledVerdict('b', false)],
    )
    expect(() => assertTeachingConditions(a)).toThrow(MissingErroredVerdictError)
    expect(() => assertTeachingConditions(a)).toThrow(/no judge verdict is ERRORED/)
  })

  it('throws EmptyGoldenLegError on an empty golden leg', () => {
    const a = artifact([], [erroredVerdict('a')])
    expect(() => assertTeachingConditions(a)).toThrow(EmptyGoldenLegError)
  })

  it('throws EmptyJudgeLegError on an empty judge leg', () => {
    const a = artifact([failingGolden('a')], [])
    expect(() => assertTeachingConditions(a)).toThrow(EmptyJudgeLegError)
  })
})

describe('serializeArtifact', () => {
  it('produces pretty-printed JSON with a trailing newline that round-trips', () => {
    const a = artifact([failingGolden('a')], [erroredVerdict('a')])
    const s = serializeArtifact(a)
    expect(s.endsWith('\n')).toBe(true)
    expect(s).toContain('\n  ') // indented
    expect(JSON.parse(s)).toEqual(a)
  })

  it('is byte-stable for identical input', () => {
    const a = artifact([failingGolden('a')], [erroredVerdict('a')])
    expect(serializeArtifact(a)).toBe(serializeArtifact(a))
  })
})
