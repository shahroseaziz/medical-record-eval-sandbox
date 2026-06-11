// O7b — run scoring fan-out. Scoring consumes a BenchRunOutput (fresh regenerated
// text + its captured grounding) and grades it with the scorers the case's
// fieldScorers assigns. The HTTP seam is injected, so judge dispatch is verified
// deterministically with no network (D15 record-replay discipline).
import { describe, it, expect } from 'vitest'
import { scoreRunCase, assembleCapturedGrounding, type PostJson } from '../run-scoring'
import type { BenchCaseV4, BenchRunOutput } from '@/lib/cases'
import type { Thresholds } from '@/lib/eval/thresholds'

const THRESHOLDS: Thresholds = {
  faithfulness: 0.85,
  contains: 1.0,
  referenceJudge: 0.8,
  judgeKappaMin: 0.4,
  extractionCompleteness: 0.0,
  structuredDiff: 0.0,
}

function benchCase(over: Partial<BenchCaseV4> = {}): BenchCaseV4 {
  return {
    version: 4,
    id: 'c1',
    taskPrompt: 'list meds',
    patientId: 'c1',
    ragMode: 'stuff',
    fieldScorers: { prose: 'faithfulness' },
    createdAt: 0,
    ...over,
  }
}

function output(text: string): BenchRunOutput {
  return {
    text,
    genPromptHash: 'H',
    capturedGrounding: { mode: 'stuff', record: '[medications]\nLisinopril 10mg daily' },
  }
}

describe('assembleCapturedGrounding', () => {
  it('returns the record in stuff mode', () => {
    expect(assembleCapturedGrounding({ mode: 'stuff', record: 'r' })).toBe('r')
  })
  it('joins chunks in retrieve mode', () => {
    const g = assembleCapturedGrounding({
      mode: 'retrieve',
      chunks: [
        { section: 'meds', text: 'A', distance: 0.1, similarity: 0.9 },
        { section: 'labs', text: 'B', distance: 0.2, similarity: 0.8 },
      ],
    })
    expect(g).toBe('[meds]\nA\n\n---\n\n[labs]\nB')
  })
})

describe('scoreRunCase — faithfulness dispatch', () => {
  it('posts to /api/score with the captured output + grounding and classifies matched', async () => {
    let postedUrl = ''
    let postedBody: Record<string, unknown> | null = null
    const post: PostJson = async (url, body) => {
      postedUrl = url
      postedBody = body as Record<string, unknown>
      return { status: 200, data: { score: 1.0, claims: [] } }
    }
    const { row, rateLimited } = await scoreRunCase(benchCase(), output('Lisinopril 10mg'), THRESHOLDS, post)
    expect(rateLimited).toBe(false)
    expect(postedUrl).toBe('/api/score')
    expect(postedBody).toMatchObject({
      source: 'captured',
      capturedOutput: 'Lisinopril 10mg',
      capturedGrounding: '[medications]\nLisinopril 10mg daily',
    })
    expect(row!.score).toBe(1.0)
    expect(row!.state).toBe('matched')
  })

  it('classifies a below-threshold faithfulness score as mismatched', async () => {
    const post: PostJson = async () => ({ status: 200, data: { score: 0.5, claims: [] } })
    const { row } = await scoreRunCase(benchCase(), output('x'), THRESHOLDS, post)
    expect(row!.state).toBe('mismatched')
  })

  it('a 429 aborts the row (null row, rateLimited) so the pass can resume later', async () => {
    const post: PostJson = async () => ({ status: 429, data: null })
    const { row, rateLimited } = await scoreRunCase(benchCase(), output('x'), THRESHOLDS, post)
    expect(row).toBeNull()
    expect(rateLimited).toBe(true)
  })

  it('a judge error surfaces as judge-errored (no fabricated score)', async () => {
    const post: PostJson = async () => ({ status: 200, data: { score: null, errored: true, claims: [] } })
    const { row } = await scoreRunCase(benchCase(), output('x'), THRESHOLDS, post)
    expect(row!.state).toBe('judge-errored')
  })
})

describe('scoreRunCase — reference-judge dispatch', () => {
  it('posts the output as actual against the case expectedProse', async () => {
    let postedUrl = ''
    let postedBody: Record<string, unknown> | null = null
    const post: PostJson = async (url, body) => {
      postedUrl = url
      postedBody = body as Record<string, unknown>
      return { status: 200, data: { score: 1.0 } }
    }
    const c = benchCase({ fieldScorers: { prose: 'reference-judge' }, expectedProse: 'the answer' })
    const { row } = await scoreRunCase(c, output('the answer'), THRESHOLDS, post)
    expect(postedUrl).toBe('/api/score-reference')
    expect(postedBody).toMatchObject({ actual: 'the answer', expected: 'the answer' })
    expect(row!.state).toBe('matched')
  })

  it('skips reference-judge when the case has no expectedProse (nothing to grade)', async () => {
    let called = false
    const post: PostJson = async () => {
      called = true
      return { status: 200, data: { score: 1.0 } }
    }
    const c = benchCase({ fieldScorers: { prose: 'reference-judge' } })
    const { row } = await scoreRunCase(c, output('x'), THRESHOLDS, post)
    expect(called).toBe(false)
    expect(row!.state).toBe('skipped')
  })
})

describe('scoreRunCase — structured-diff dispatch (client-side, no model call)', () => {
  it('skips when no expected structured value is authored', async () => {
    let called = false
    const post: PostJson = async () => {
      called = true
      return { status: 200, data: null }
    }
    const c = benchCase({ fieldScorers: { structured: 'structured-diff' } })
    const { row } = await scoreRunCase(c, output('{}'), THRESHOLDS, post)
    expect(called).toBe(false)
    expect(row!.state).toBe('skipped')
  })
})
