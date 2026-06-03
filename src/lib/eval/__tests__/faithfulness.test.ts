import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { scoreFaithfulness, buildExtractPrompt, buildVerdictPrompt } from '../scorers/faithfulness'
import type { EvalCase } from '../types'

function makeRetrieveCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-1',
    patientId: 'p1',
    query: 'What medications is the patient on?',
    output: 'The patient takes Lisinopril 10mg daily for hypertension.',
    mode: 'retrieve',
    retrievedChunks: [
      { section: 'medications', text: 'Lisinopril 10mg daily — prescribed for hypertension.' },
    ],
    expectedOutput: 'Lisinopril',
    ...overrides,
  }
}

function makeStuffCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'test-2',
    patientId: 'p1',
    query: 'Summarize the record.',
    output: 'Patient has hypertension managed with Lisinopril.',
    mode: 'stuff',
    record: 'Patient: John Doe. Condition: Hypertension. Medication: Lisinopril 10mg.',
    ...overrides,
  }
}

function makeMockClient(responses: object[]): Anthropic {
  const create = vi.fn()
  responses.forEach((r) => create.mockResolvedValueOnce(r))
  return { messages: { create } } as unknown as Anthropic
}

function extractResponse(claims: string[]) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'extract_claims',
        input: { claims },
      },
    ],
  }
}

function verdictResponse(verdicts: Array<{ claim: string; verdict: string; rationale: string }>) {
  return {
    content: [
      {
        type: 'tool_use',
        name: 'verdict_claims',
        input: { verdicts },
      },
    ],
  }
}

function unparseableResponse() {
  return { content: [{ type: 'text', text: 'sorry I cannot do that' }] }
}

describe('scoreFaithfulness', () => {
  describe('two-call sequence', () => {
    it('makes exactly two Claude calls in order (extract then verdict)', async () => {
      const client = makeMockClient([
        extractResponse(['Patient takes Lisinopril 10mg.']),
        verdictResponse([
          { claim: 'Patient takes Lisinopril 10mg.', verdict: 'supported', rationale: 'explicitly stated' },
        ]),
      ])

      const result = await scoreFaithfulness(makeRetrieveCase(), client)

      const mockCreate = (client.messages.create as ReturnType<typeof vi.fn>)
      expect(mockCreate.mock.calls).toHaveLength(2)
      expect(result.errored).toBeUndefined()
      expect(result.score).toBe(1.0)
    })

    it('surfaces extractPrompt and verdictPrompt in result', async () => {
      const client = makeMockClient([
        extractResponse(['Claim one.']),
        verdictResponse([
          { claim: 'Claim one.', verdict: 'supported', rationale: 'found in context' },
        ]),
      ])

      const result = await scoreFaithfulness(makeRetrieveCase(), client)

      expect(result.extractPrompt).toContain('The patient takes Lisinopril')
      expect(result.verdictPrompt).toContain('Claim one.')
      expect(result.verdictPrompt).toContain('Lisinopril 10mg daily')
    })
  })

  describe('grounding context firewall', () => {
    it('retrieve mode: grounding contains only retrieved chunks, not query or expectedOutput', async () => {
      const create = vi.fn()
      create.mockResolvedValueOnce(extractResponse(['claim']))
      create.mockResolvedValueOnce(
        verdictResponse([{ claim: 'claim', verdict: 'supported', rationale: 'ok' }])
      )
      const client = { messages: { create } } as unknown as Anthropic

      const evalCase = makeRetrieveCase({
        query: 'SENSITIVE_TASK_INSTRUCTION',
        expectedOutput: 'SENSITIVE_EXPECTED_OUTPUT',
        retrievedChunks: [{ section: 'medications', text: 'CHUNK_CONTENT' }],
      })

      await scoreFaithfulness(evalCase, client)

      const verdictCall = create.mock.calls[1] as [{ messages: [{ content: string }] }]
      const verdictPrompt = verdictCall[0].messages[0].content

      expect(verdictPrompt).toContain('CHUNK_CONTENT')
      expect(verdictPrompt).not.toContain('SENSITIVE_TASK_INSTRUCTION')
      expect(verdictPrompt).not.toContain('SENSITIVE_EXPECTED_OUTPUT')
    })

    it('stuff mode: grounding contains only the record, not query or expectedOutput', async () => {
      const create = vi.fn()
      create.mockResolvedValueOnce(extractResponse(['claim']))
      create.mockResolvedValueOnce(
        verdictResponse([{ claim: 'claim', verdict: 'supported', rationale: 'ok' }])
      )
      const client = { messages: { create } } as unknown as Anthropic

      const evalCase = makeStuffCase({
        query: 'SENSITIVE_QUERY',
        expectedOutput: 'SENSITIVE_EXPECTED',
        record: 'RECORD_CONTENT',
      })

      await scoreFaithfulness(evalCase, client)

      const verdictCall = create.mock.calls[1] as [{ messages: [{ content: string }] }]
      const verdictPrompt = verdictCall[0].messages[0].content

      expect(verdictPrompt).toContain('RECORD_CONTENT')
      expect(verdictPrompt).not.toContain('SENSITIVE_QUERY')
      expect(verdictPrompt).not.toContain('SENSITIVE_EXPECTED')
    })
  })

  describe('scoring logic', () => {
    it('partial verdict counts as NOT supported in score', async () => {
      const client = makeMockClient([
        extractResponse(['Claim A', 'Claim B']),
        verdictResponse([
          { claim: 'Claim A', verdict: 'supported', rationale: 'found' },
          { claim: 'Claim B', verdict: 'partial', rationale: 'weakly' },
        ]),
      ])

      const result = await scoreFaithfulness(makeRetrieveCase(), client)

      // 1 supported out of 2 total; partial does not count
      expect(result.score).toBeCloseTo(0.5)
      const claimB = result.claims.find((c) => c.claim === 'Claim B')
      expect(claimB?.verdict).toBe('partial')
    })

    it('all supported -> score 1.0', async () => {
      const client = makeMockClient([
        extractResponse(['A', 'B']),
        verdictResponse([
          { claim: 'A', verdict: 'supported', rationale: 'yes' },
          { claim: 'B', verdict: 'supported', rationale: 'yes' },
        ]),
      ])
      const result = await scoreFaithfulness(makeRetrieveCase(), client)
      expect(result.score).toBe(1.0)
    })

    it('all unsupported -> score 0.0', async () => {
      const client = makeMockClient([
        extractResponse(['A', 'B']),
        verdictResponse([
          { claim: 'A', verdict: 'unsupported', rationale: 'not found' },
          { claim: 'B', verdict: 'unsupported', rationale: 'not found' },
        ]),
      ])
      const result = await scoreFaithfulness(makeRetrieveCase(), client)
      expect(result.score).toBe(0.0)
    })
  })

  describe('zero-claim output', () => {
    it('returns score 1.0 with zeroClaimFlag when extract returns empty list', async () => {
      const create = vi.fn()
      create.mockResolvedValueOnce(extractResponse([]))
      const client = { messages: { create } } as unknown as Anthropic

      const result = await scoreFaithfulness(makeRetrieveCase(), client)

      expect(result.score).toBe(1.0)
      expect(result.zeroClaimFlag).toBe(true)
      // Only one call (no verdict needed for zero claims)
      expect(create.mock.calls).toHaveLength(1)
      expect(result.errored).toBeUndefined()
    })
  })

  describe('error handling — judge terminal failure', () => {
    it('extract: both attempts unparseable -> errored, score is null (not a number)', async () => {
      const client = makeMockClient([
        unparseableResponse(),
        unparseableResponse(),
      ])

      const result = await scoreFaithfulness(makeRetrieveCase(), client)

      expect(result.errored).toBe(true)
      expect(result.score).toBeNull()
      expect(typeof result.score).not.toBe('number')
      expect(result.errorMessage).toMatch(/extract/i)
    })

    it('verdict: both attempts unparseable -> errored, score is null (not a number)', async () => {
      const client = makeMockClient([
        extractResponse(['Some claim.']),
        unparseableResponse(),
        unparseableResponse(),
      ])

      const result = await scoreFaithfulness(makeRetrieveCase(), client)

      expect(result.errored).toBe(true)
      expect(result.score).toBeNull()
      expect(typeof result.score).not.toBe('number')
      expect(result.errorMessage).toMatch(/verdict/i)
    })

    it('extract: first attempt fails, second succeeds -> returns valid score', async () => {
      const client = makeMockClient([
        unparseableResponse(),
        extractResponse(['Retry claim.']),
        verdictResponse([
          { claim: 'Retry claim.', verdict: 'supported', rationale: 'found' },
        ]),
      ])

      const result = await scoreFaithfulness(makeRetrieveCase(), client)

      expect(result.errored).toBeUndefined()
      expect(result.score).toBe(1.0)
      const mockCreate = (client.messages.create as ReturnType<typeof vi.fn>)
      expect(mockCreate.mock.calls).toHaveLength(3)
    })
  })
})

describe('buildExtractPrompt', () => {
  it('contains the output text to analyze', () => {
    const prompt = buildExtractPrompt('Patient takes aspirin.')
    expect(prompt).toContain('Patient takes aspirin.')
  })

  it('does not mention grounding, query, or expected output', () => {
    const prompt = buildExtractPrompt('some output')
    expect(prompt.toLowerCase()).not.toContain('grounding')
    expect(prompt.toLowerCase()).not.toContain('expected')
    expect(prompt.toLowerCase()).not.toContain('query')
  })
})

describe('buildVerdictPrompt', () => {
  it('contains all claims and the grounding context', () => {
    const prompt = buildVerdictPrompt(['Claim A', 'Claim B'], 'GROUNDING TEXT')
    expect(prompt).toContain('Claim A')
    expect(prompt).toContain('Claim B')
    expect(prompt).toContain('GROUNDING TEXT')
  })
})
