import { describe, it, expect, vi } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import {
  deriveFieldScorers,
  scorerChips,
  hasAuthoredProse,
  hasAuthoredStructured,
} from '../scorer-assignment'
import { scoreReferenceJudge } from '@/lib/eval/scorers/reference-judge'

// ── E25 derivation (derived-with-override) ───────────────────────────────────

describe('deriveFieldScorers (E25)', () => {
  it('authored prose → prose: reference-judge (NOT the old hardcoded faithfulness)', () => {
    expect(deriveFieldScorers({ expectedProse: 'Patient takes Lisinopril 10mg daily.' })).toEqual({
      prose: 'reference-judge',
    })
  })

  it('authored structured (field-builder rows) → structured: structured-diff', () => {
    expect(
      deriveFieldScorers({
        expectedStructured: [{ drug: 'Lisinopril', dose: '10mg', route: 'PO', status: 'active' }],
      }),
    ).toEqual({ structured: 'structured-diff' })
  })

  it('neither authored → prose: faithfulness (grounding is the truth standard)', () => {
    expect(deriveFieldScorers({})).toEqual({ prose: 'faithfulness' })
    expect(deriveFieldScorers({ expectedProse: '   ' })).toEqual({ prose: 'faithfulness' })
  })

  it('both authored → mixed assignment rolls both fields', () => {
    expect(
      deriveFieldScorers({
        expectedProse: 'two active meds',
        expectedStructured: [{ drug: 'Lisinopril', dose: '10mg', route: 'PO', status: 'active' }],
      }),
    ).toEqual({ prose: 'reference-judge', structured: 'structured-diff' })
  })

  it('respects a per-field override for an authored field', () => {
    expect(
      deriveFieldScorers(
        { expectedProse: 'no aspirin allergy documented' },
        { prose: 'faithfulness' },
      ),
    ).toEqual({ prose: 'faithfulness' })
  })

  it('ignores an override targeting a field with no authored content', () => {
    // No structured authored → the structured override has nothing to grade.
    expect(
      deriveFieldScorers({ expectedProse: 'x' }, { structured: 'structured-diff' }),
    ).toEqual({ prose: 'reference-judge' })
  })

  it('treats an empty structured object/array as not authored', () => {
    expect(hasAuthoredStructured([])).toBe(false)
    expect(hasAuthoredStructured({})).toBe(false)
    expect(hasAuthoredStructured(undefined)).toBe(false)
    expect(hasAuthoredProse('')).toBe(false)
    expect(hasAuthoredProse('x')).toBe(true)
  })
})

// ── Evaluator chips per case / per field ─────────────────────────────────────

describe('scorerChips', () => {
  it('renders the derived default with isDefault true', () => {
    const chips = scorerChips({ expectedProse: 'something' })
    expect(chips).toHaveLength(1)
    expect(chips[0]).toMatchObject({
      field: 'prose',
      scorer: 'reference-judge',
      fieldLabel: 'Prose',
      scorerLabel: 'Reference judge',
      isDefault: true,
    })
  })

  it('marks an overridden scorer as not default', () => {
    const chips = scorerChips({
      expectedProse: 'something',
      fieldScorers: { prose: 'faithfulness' },
    })
    expect(chips[0]).toMatchObject({ scorer: 'faithfulness', isDefault: false })
  })

  it('orders prose before structured regardless of map key order', () => {
    const chips = scorerChips({
      expectedProse: 'p',
      expectedStructured: [{ drug: 'X', dose: '1mg', route: 'PO', status: 'active' }],
      fieldScorers: { structured: 'structured-diff', prose: 'reference-judge' },
    })
    expect(chips.map((c) => c.field)).toEqual(['prose', 'structured'])
  })
})

// ── Reference-effect regression (E28a / O4 acceptance) ───────────────────────
//
// The motivating defect (#15786): the capture flow hardcoded
// `fieldScorers: { prose: 'faithfulness' }` regardless of the authored reference,
// so the reference had NO effect on the score. This test proves the fix end-to-end:
// two cases identical in everything but their authored reference are assigned the
// reference-judge scorer (by derivation) and produce DIFFERENT scores, because the
// reference now genuinely flows into scoring.

// A meaning-by-equality judge stand-in (rule 20 deterministic seam): it reads the
// EXPECTED + ACTUAL blocks out of the prompt and returns `equivalent` iff they
// match — so swapping the reference necessarily swings the verdict. This is what a
// hardcoded-faithfulness path (which never reads the reference) could not do.
function makeReferenceSensitiveJudge(): Anthropic {
  const create = vi.fn(async (req: { messages: [{ content: string }] }) => {
    const prompt = req.messages[0].content
    const expected = /EXPECTED \(reference output\):\n([\s\S]*?)\n\nACTUAL/.exec(prompt)?.[1].trim()
    const actual = /ACTUAL \(model output to score\):\n([\s\S]*?)\n\nAssign/.exec(prompt)?.[1].trim()
    const verdict = expected === actual ? 'equivalent' : 'divergent'
    return {
      content: [
        {
          type: 'tool_use',
          name: 'reference_verdict',
          input: { verdict, reason: 'reference-sensitive stub' },
        },
      ],
    }
  })
  return { messages: { create } } as unknown as Anthropic
}

describe('reference-effect (E28a regression)', () => {
  it('identical cases with different references get reference-judge and different scores', async () => {
    const output = 'Patient takes Lisinopril 10mg daily.'

    const caseMatching = { expectedProse: 'Patient takes Lisinopril 10mg daily.' }
    const caseDiverging = { expectedProse: 'Patient takes Aspirin 81mg daily.' }

    // Both cases derive the SAME scorer — reference-judge — proving the defect fix:
    // the authored reference is no longer ignored in favor of hardcoded faithfulness.
    expect(deriveFieldScorers(caseMatching)).toEqual({ prose: 'reference-judge' })
    expect(deriveFieldScorers(caseDiverging)).toEqual({ prose: 'reference-judge' })

    const judge = makeReferenceSensitiveJudge()
    const scoreMatching = await scoreReferenceJudge(output, caseMatching.expectedProse, judge)
    const scoreDiverging = await scoreReferenceJudge(output, caseDiverging.expectedProse, judge)

    // Same output, same scorer, DIFFERENT reference ⇒ different score.
    expect(scoreMatching.score).toBe(1.0)
    expect(scoreDiverging.score).toBe(0.0)
    expect(scoreMatching.score).not.toBe(scoreDiverging.score)
  })
})
