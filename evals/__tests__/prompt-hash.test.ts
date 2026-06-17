import { describe, it, expect } from 'vitest'
import {
  checkJudgePromptParity,
  computeJudgePromptHashes,
  EXPECTED_JUDGE_PROMPT_HASHES,
} from '../harness/prompt-hash'

// O11/E28(f): the judge prompt templates are pinned into the parity equality
// class. A template edit must fail here (and the gate) until deliberately
// re-baselined — never a silent score re-roll. N13b extends the pin to the
// single-call criteria-judge template and the worked example's pinned CRITERIA
// text (both ruled the committed worked-example verdicts the nightly canary
// re-runs against).
describe('judge-prompt parity (E28f)', () => {
  it('the rendered templates match the committed baseline', () => {
    expect(checkJudgePromptParity()).toEqual([])
  })

  it('covers every pinned judge template, with no key set drift', () => {
    expect(Object.keys(computeJudgePromptHashes()).sort()).toEqual(
      Object.keys(EXPECTED_JUDGE_PROMPT_HASHES).sort(),
    )
  })

  it('pins the criteria-judge template + the worked-example criteria text (N13b)', () => {
    const hashes = computeJudgePromptHashes()
    expect(hashes.criteria).toBe(EXPECTED_JUDGE_PROMPT_HASHES.criteria)
    expect(hashes.workedCriteria).toBe(EXPECTED_JUDGE_PROMPT_HASHES.workedCriteria)
  })

  it('hashes are deterministic across renders', () => {
    expect(computeJudgePromptHashes()).toEqual(computeJudgePromptHashes())
  })
})
