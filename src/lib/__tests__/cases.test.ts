// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadUserCases,
  saveUserCase,
  deleteUserCase,
  aggregateSeededCases,
  loadUserCasesV2,
  saveUserCaseV2,
  deleteUserCaseV2,
  genPromptHash,
  isCaseStale,
  serializeState,
  deserializeState,
  saveGenPrompt,
  saveJudgeRubric,
  loadGenPrompt,
  loadJudgeRubric,
  type UserCase,
  type SeededCase,
  type UserCaseV2,
} from '../cases'

const SEED_CASES: SeededCase[] = [
  {
    id: 'seed-1',
    patientId: 'p001',
    query: 'What medications is the patient taking?',
    mode: 'retrieve',
    referenceLabel: 'med-query-v1',
    requiredSections: ['medications'],
    rationale: 'Tests medication retrieval',
  },
  {
    id: 'seed-2',
    patientId: 'p002',
    query: 'List all known allergies.',
    mode: 'stuff',
    referenceLabel: 'allergy-query-v1',
    requiredSections: [],
    rationale: 'Tests full-record stuffing',
    expectedOutput: 'penicillin',
    record: 'Allergy: penicillin',
  },
]

const makeUserCase = (id: string): UserCase => ({
  id,
  patientId: 'p-user',
  query: 'Any recent lab results?',
  mode: 'retrieve',
  createdAt: Date.now(),
})

const GEN_PROMPT = 'You are a medical AI. Given the patient record, answer the question.'

const makeUserCaseV2 = (id: string, hash: string): UserCaseV2 => ({
  id,
  taskPrompt: GEN_PROMPT,
  patientId: 'p-v2',
  ragMode: 'retrieve',
  capturedOutput: 'Medication: metformin 500mg',
  capturedGrounding: {
    mode: 'retrieve',
    chunks: [{ text: 'metformin', section: 'medications', distance: 0.1, similarity: 0.9 }],
  },
  intentLabel: 'pass',
  provenance: {
    genPromptHash: hash,
    patientId: 'p-v2',
    ragMode: 'retrieve',
    k: 5,
  },
  createdAt: 1000000,
})

describe('UserCase localStorage CRUD', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts empty', () => {
    expect(loadUserCases()).toHaveLength(0)
  })

  it('saves and loads a case', () => {
    const uc = makeUserCase('u-1')
    saveUserCase(uc)
    const loaded = loadUserCases()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('u-1')
    expect(loaded[0].query).toBe(uc.query)
  })

  it('updates an existing case on re-save', () => {
    const uc = makeUserCase('u-2')
    saveUserCase(uc)
    saveUserCase({ ...uc, query: 'Updated query' })
    const loaded = loadUserCases()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].query).toBe('Updated query')
  })

  it('deletes a case', () => {
    saveUserCase(makeUserCase('u-3'))
    saveUserCase(makeUserCase('u-4'))
    deleteUserCase('u-3')
    const loaded = loadUserCases()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('u-4')
  })
})

describe('user-case exclusion: seeded aggregate is unaffected by localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('aggregateSeededCases returns correct stats for seeded set', () => {
    const agg = aggregateSeededCases(SEED_CASES)
    expect(agg.count).toBe(2)
    expect(agg.ids).toEqual(['seed-1', 'seed-2'])
    expect(agg.modeBreakdown.retrieve).toBe(1)
    expect(agg.modeBreakdown.stuff).toBe(1)
    expect(agg.withExpectedOutput).toBe(1)
  })

  it('saving a user case to localStorage does NOT alter the seeded aggregate', () => {
    const before = aggregateSeededCases(SEED_CASES)

    // Simulate a user saving multiple cases
    saveUserCase(makeUserCase('u-x1'))
    saveUserCase(makeUserCase('u-x2'))
    saveUserCase({ ...makeUserCase('u-x3'), mode: 'stuff', expectedOutput: 'some expected' })

    // User cases exist in localStorage
    expect(loadUserCases()).toHaveLength(3)

    // The seeded aggregate is identical — aggregateSeededCases is a pure function
    const after = aggregateSeededCases(SEED_CASES)
    expect(after).toEqual(before)
    expect(after.count).toBe(2)
    expect(after.withExpectedOutput).toBe(1)
  })

  it('deleting all user cases does NOT change the seeded aggregate', () => {
    saveUserCase(makeUserCase('u-y'))
    deleteUserCase('u-y')

    const agg = aggregateSeededCases(SEED_CASES)
    expect(agg.count).toBe(2)
  })

  it('empty seed set produces zero aggregate', () => {
    const agg = aggregateSeededCases([])
    expect(agg.count).toBe(0)
    expect(agg.ids).toEqual([])
    expect(agg.modeBreakdown.retrieve).toBe(0)
    expect(agg.modeBreakdown.stuff).toBe(0)
  })
})

// ── UserCaseV2 tests ───────────────────────────────────────────────────────

describe('UserCaseV2 localStorage CRUD', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('starts empty', () => {
    expect(loadUserCasesV2()).toHaveLength(0)
  })

  it('round-trips a case through localStorage', () => {
    const hash = genPromptHash(GEN_PROMPT)
    const uc = makeUserCaseV2('v2-1', hash)
    saveUserCaseV2(uc)
    const loaded = loadUserCasesV2()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(uc)
  })

  it('preserves all fields including nested grounding and provenance', () => {
    const hash = genPromptHash(GEN_PROMPT)
    const uc: UserCaseV2 = {
      ...makeUserCaseV2('v2-full', hash),
      referenceOutput: 'metformin 500mg twice daily',
      intentLabel: 'fail',
      designedFailReason: 'wrong dosage',
      capturedGrounding: {
        mode: 'stuff',
        record: 'raw record text',
      },
    }
    saveUserCaseV2(uc)
    const loaded = loadUserCasesV2()
    expect(loaded[0]).toEqual(uc)
    expect(loaded[0].capturedGrounding.record).toBe('raw record text')
    expect(loaded[0].designedFailReason).toBe('wrong dosage')
  })

  it('updates an existing case on re-save', () => {
    const hash = genPromptHash(GEN_PROMPT)
    const uc = makeUserCaseV2('v2-2', hash)
    saveUserCaseV2(uc)
    saveUserCaseV2({ ...uc, intentLabel: 'fail', designedFailReason: 'wrong section' })
    const loaded = loadUserCasesV2()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].intentLabel).toBe('fail')
    expect(loaded[0].designedFailReason).toBe('wrong section')
  })

  it('deletes a case', () => {
    const hash = genPromptHash(GEN_PROMPT)
    saveUserCaseV2(makeUserCaseV2('v2-3', hash))
    saveUserCaseV2(makeUserCaseV2('v2-4', hash))
    deleteUserCaseV2('v2-3')
    const loaded = loadUserCasesV2()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe('v2-4')
  })
})

describe('genPromptHash: whitespace normalization and staleness', () => {
  it('identical prompts produce the same hash', () => {
    expect(genPromptHash('hello world')).toBe(genPromptHash('hello world'))
  })

  it('whitespace-only edits do NOT change the hash', () => {
    const base = 'Answer the question.'
    expect(genPromptHash(base)).toBe(genPromptHash('  Answer   the question.  '))
    expect(genPromptHash(base)).toBe(genPromptHash('Answer the question.\n'))
    expect(genPromptHash(base)).toBe(genPromptHash('\tAnswer  the  question.\t'))
  })

  it('meaningful content changes DO change the hash', () => {
    expect(genPromptHash('Prompt A')).not.toBe(genPromptHash('Prompt B'))
  })

  it('isCaseStale returns false when hash matches current prompt', () => {
    const prompt = 'The original prompt.'
    const hash = genPromptHash(prompt)
    const uc = makeUserCaseV2('stale-1', hash)
    expect(isCaseStale(uc, prompt)).toBe(false)
  })

  it('isCaseStale returns false on whitespace-only edit (not stale)', () => {
    const prompt = 'The original prompt.'
    const hash = genPromptHash(prompt)
    const uc = makeUserCaseV2('stale-2', hash)
    expect(isCaseStale(uc, '  The original  prompt.  ')).toBe(false)
    expect(isCaseStale(uc, 'The original prompt.\n')).toBe(false)
  })

  it('isCaseStale returns true when prompt content changes (hash drift)', () => {
    const prompt = 'The original prompt.'
    const hash = genPromptHash(prompt)
    const uc = makeUserCaseV2('stale-3', hash)
    expect(isCaseStale(uc, 'A completely different prompt.')).toBe(true)
  })
})

describe('account-portable state blob: serialize/deserialize', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('serialized blob has the correct schema shape', () => {
    saveGenPrompt('my gen prompt')
    saveJudgeRubric('my rubric')
    const parsed = JSON.parse(serializeState())
    expect(parsed.version).toBe(1)
    expect(parsed.genPrompt).toBe('my gen prompt')
    expect(parsed.judgeRubric).toBe('my rubric')
    expect(Array.isArray(parsed.cases)).toBe(true)
  })

  it('round-trips the full state losslessly', () => {
    const hash = genPromptHash(GEN_PROMPT)
    saveGenPrompt(GEN_PROMPT)
    saveJudgeRubric('Score 0-3 on faithfulness.')
    saveUserCaseV2(makeUserCaseV2('blob-1', hash))
    saveUserCaseV2(makeUserCaseV2('blob-2', hash))

    const blob = serializeState()
    localStorage.clear()
    deserializeState(blob)

    expect(loadGenPrompt()).toBe(GEN_PROMPT)
    expect(loadJudgeRubric()).toBe('Score 0-3 on faithfulness.')
    const cases = loadUserCasesV2()
    expect(cases).toHaveLength(2)
    expect(cases[0]).toEqual(makeUserCaseV2('blob-1', hash))
    expect(cases[1]).toEqual(makeUserCaseV2('blob-2', hash))
  })

  it('empty state round-trips losslessly', () => {
    const blob = serializeState()
    localStorage.clear()
    deserializeState(blob)

    expect(loadGenPrompt()).toBe('')
    expect(loadJudgeRubric()).toBe('')
    expect(loadUserCasesV2()).toEqual([])
  })

  it('throws on unsupported blob version', () => {
    const bad = JSON.stringify({ version: 99, genPrompt: '', judgeRubric: '', cases: [] })
    expect(() => deserializeState(bad)).toThrow('Unsupported state blob version: 99')
  })

  it('throws with a clear message on malformed JSON (e.g. truncated paste)', () => {
    expect(() => deserializeState('{"version":1,"genPrompt":"x')).toThrow(
      'deserializeState: invalid JSON',
    )
  })

  it('absent blob.cases falls back to [] — does not write "undefined" string', () => {
    // Blob with no cases field
    const partial = JSON.stringify({ version: 1, genPrompt: 'gp', judgeRubric: 'jr' })
    deserializeState(partial)
    expect(loadUserCasesV2()).toEqual([])
    // Verify the raw key is not the string "undefined"
    expect(localStorage.getItem('user_cases_v2')).not.toBe('undefined')
  })

  it('absent blob.genPrompt falls back to "" — does not write "undefined" string', () => {
    const partial = JSON.stringify({ version: 1, judgeRubric: 'jr', cases: [] })
    deserializeState(partial)
    expect(loadGenPrompt()).toBe('')
    expect(localStorage.getItem('gen_prompt_v1')).not.toBe('undefined')
  })

  it('absent blob.judgeRubric falls back to "" — does not write "undefined" string', () => {
    const partial = JSON.stringify({ version: 1, genPrompt: 'gp', cases: [] })
    deserializeState(partial)
    expect(loadJudgeRubric()).toBe('')
    expect(localStorage.getItem('judge_rubric_v1')).not.toBe('undefined')
  })
})

describe('UserCaseV2 isolation: seeded aggregate unaffected by v2 localStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('v2 cases in localStorage do not alter the seeded aggregate', () => {
    const before = aggregateSeededCases(SEED_CASES)
    const hash = genPromptHash(GEN_PROMPT)
    saveUserCaseV2(makeUserCaseV2('iso-1', hash))
    saveUserCaseV2(makeUserCaseV2('iso-2', hash))
    const after = aggregateSeededCases(SEED_CASES)
    expect(after).toEqual(before)
    expect(after.count).toBe(2)
  })

  it('v2 cases with mode stuff do not contaminate retrieve count in seeded aggregate', () => {
    const hash = genPromptHash(GEN_PROMPT)
    saveUserCaseV2({ ...makeUserCaseV2('iso-3', hash), ragMode: 'stuff' })
    const agg = aggregateSeededCases(SEED_CASES)
    expect(agg.modeBreakdown.retrieve).toBe(1)
    expect(agg.modeBreakdown.stuff).toBe(1)
  })
})
