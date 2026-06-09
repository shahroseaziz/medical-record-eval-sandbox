import { describe, it, expect } from 'vitest'
import { loadLessonBeat2 } from '../beat2'

/**
 * Beat 2 acceptance, at the data layer (SHA-61 R9). The whole beat is computed
 * offline from committed data — `scoreStructuredDiff` is a pure function and the
 * reference verdict is a record-replay fixture — so these assertions pin the three
 * acceptance behaviours and prove the beat can never drift or flap:
 *   1. the structured diff visibly FAILS on semantically-correct prose,
 *   2. the reference judge RESOLVES it (equivalent),
 *   3. the "this judge can be wrong too" seed is present (no oracle framing).
 */
describe('lesson Beat 2 — prose contrast (committed)', () => {
  const data = loadLessonBeat2()

  it('the structured diff cannot grade the prose answer — it errors, score is null', () => {
    expect(data.diff.errored).toBe(true)
    expect(data.diff.score).toBeNull()
    // it fails because prose is not field-structured, not because the answer is wrong
    expect(data.diff.errorMessage).toMatch(/not valid JSON/i)
    expect(data.diff.fields).toHaveLength(0)
  })

  it('the reference judge resolves the prose answer as equivalent (1.0)', () => {
    expect(data.judge.verdict).toBe('equivalent')
    expect(data.judge.score).toBe(1)
    expect(data.judge.reason).toBeTruthy()
  })

  it('the judge prompt is redacted — no raw prose persisted (rule 17)', () => {
    expect(data.judge.judgePrompt).toContain('redacted sha256=')
    expect(data.judge.judgePrompt).not.toContain('hemoglobin')
    expect(data.judge.judgePrompt).not.toMatch(/poorly controlled/i)
  })

  it('plants the judge-fallibility seed with no oracle framing', () => {
    expect(data.fallibilitySeed).toBeTruthy()
    // the seed must frame the judge as fallible / not the source of truth
    expect(data.fallibilitySeed).toMatch(/fallible|not the ground truth|not an oracle|can be wrong/i)
  })

  it('renders identically on repeated loads (no flap, no model call)', () => {
    expect(JSON.stringify(loadLessonBeat2())).toBe(JSON.stringify(loadLessonBeat2()))
  })
})
