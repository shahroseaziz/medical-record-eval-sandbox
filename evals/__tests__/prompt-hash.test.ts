import { describe, it, expect } from 'vitest'
import {
  checkJudgePromptParity,
  computeJudgePromptHashes,
  EXPECTED_JUDGE_PROMPT_HASHES,
} from '../harness/prompt-hash'

// O11/E28(f): the judge prompt templates are pinned into the parity equality
// class. A template edit must fail here (and the gate) until deliberately
// re-baselined — never a silent score re-roll.
describe('judge-prompt parity (E28f)', () => {
  it('the rendered templates match the committed baseline', () => {
    expect(checkJudgePromptParity()).toEqual([])
  })

  it('covers all three judge templates', () => {
    expect(Object.keys(computeJudgePromptHashes()).sort()).toEqual(
      Object.keys(EXPECTED_JUDGE_PROMPT_HASHES).sort(),
    )
  })

  it('hashes are deterministic across renders', () => {
    expect(computeJudgePromptHashes()).toEqual(computeJudgePromptHashes())
  })
})
