import { describe, it, expect } from 'vitest'
import {
  EVALUATORS,
  evaluatorHasAnswerKey,
  loadBenchCases,
  assembleGrounding,
  buildBenchResults,
  buildStructuredDiffDetails,
  FALLBACK_THRESHOLDS,
} from '../bench'
import { caseVerdict, caseScore } from '@/lib/eval/user-agreement'
import { loadLessonBeat3 } from '@/lib/lesson/beat3'

const ALLERGIES = 'beat3-allergies-rubric-sensitive-fail'
const MEDS = 'beat3-medications-pass'

describe('workbench bench', () => {
  // ── No fixture drift (R13): the bench is the lesson's last state ────────────
  // The bench MUST source its cases from the committed Beat 3 fixture, not a fork.
  // This locks the allergy case (and every other) byte-for-byte against Beat 3 so
  // a future edit to one file without the other fails CI instead of silently
  // drifting the two surfaces apart.
  it('no fixture drift: every bench case mirrors the committed Beat 3 fixture', () => {
    const benchCases = loadBenchCases()
    const beat3 = loadLessonBeat3().cases
    expect(benchCases.map((c) => c.caseId)).toEqual(beat3.map((c) => c.caseId))

    for (const b3 of beat3) {
      const bc = benchCases.find((c) => c.caseId === b3.caseId)!
      // The shared atoms — the parts the learner saw in Beat 3 — must be identical.
      expect(bc.intentLabel).toEqual(b3.intentLabel)
      expect(bc.taskPrompt).toEqual(b3.taskPrompt)
      expect(bc.output).toEqual(b3.output)
      expect(bc.designedReason).toEqual(b3.designedReason)
      expect(bc.grounding).toEqual(b3.grounding)
    }
  })

  it('no fixture drift: the allergy case is the same penicillin/sulfa/aspirin fixture in both surfaces', () => {
    const benchAllergy = loadBenchCases().find((c) => c.caseId === ALLERGIES)!
    const beat3Allergy = loadLessonBeat3().cases.find((c) => c.caseId === ALLERGIES)!
    expect(benchAllergy.output).toEqual(beat3Allergy.output)
    expect(benchAllergy.grounding).toEqual(beat3Allergy.grounding)
    // Grounding documents penicillin + sulfa but NOT aspirin — the hallucination
    // the lenient rubric is fooled by. That contract is what both surfaces share.
    const groundingText = benchAllergy.grounding.map((g) => g.text).join(' ')
    expect(groundingText).toContain('Penicillin')
    expect(groundingText).toContain('Sulfa')
    expect(groundingText).not.toContain('spirin')
  })

  it('pre-loads the lesson cases joined with an answer-key annex', () => {
    const cases = loadBenchCases()
    expect(cases.length).toBeGreaterThanOrEqual(4)
    const meds = cases.find((c) => c.caseId === MEDS)!
    expect(meds.expectedProse).toContain('Lisinopril')
    expect(meds.referenceVerdict).toBe('equivalent')
    expect(meds.expectedStructured?.medications.length).toBe(2)
    // The faithfulness cases carry grounding (no answer key needed for faithfulness).
    expect(meds.grounding.length).toBeGreaterThan(0)
  })

  it('palette is exactly the three evaluator types, only faithfulness has no answer key', () => {
    expect([...EVALUATORS]).toEqual(['faithfulness', 'reference-judge', 'structured-diff'])
    expect(evaluatorHasAnswerKey('faithfulness')).toBe(false)
    expect(evaluatorHasAnswerKey('reference-judge')).toBe(true)
    expect(evaluatorHasAnswerKey('structured-diff')).toBe(true)
  })

  it('assembles grounding into a single context string', () => {
    const cases = loadBenchCases()
    const g = assembleGrounding(cases[0].grounding)
    expect(g).toContain('[')
    expect(g.length).toBeGreaterThan(0)
  })

  // ── The red-cell aha: the allergies case flips when the rubric changes ──────
  it('faithfulness: the allergies case AGREES under strict but DISAGREES under lenient', () => {
    const cases = loadBenchCases()
    const T = FALLBACK_THRESHOLDS

    const strict = buildBenchResults('faithfulness', cases, 'strict', T)
    const strictAllergies = strict.find((r) => r.caseId === ALLERGIES)!
    // strict: aspirin claim unsupported → 2/3 ≈ 0.67 < 0.85 → FAIL, intent fail → agrees
    expect(caseScore(strictAllergies)).toBeCloseTo(2 / 3, 5)
    expect(caseVerdict(strictAllergies, T.faithfulness)).toBe('fail')
    expect(caseVerdict(strictAllergies, T.faithfulness)).toBe(strictAllergies.intentLabel)

    const lenient = buildBenchResults('faithfulness', cases, 'lenient', T)
    const lenientAllergies = lenient.find((r) => r.caseId === ALLERGIES)!
    // lenient: aspirin reads as plausible → 3/3 = 1.0 → PASS, but intent is fail → DISAGREES
    expect(caseScore(lenientAllergies)).toBeCloseTo(1, 5)
    expect(caseVerdict(lenientAllergies, T.faithfulness)).toBe('pass')
    expect(caseVerdict(lenientAllergies, T.faithfulness)).not.toBe(lenientAllergies.intentLabel)
  })

  it('reference-judge: committed verdicts are classified against the config threshold', () => {
    const cases = loadBenchCases()
    const T = FALLBACK_THRESHOLDS
    const results = buildBenchResults('reference-judge', cases, 'strict', T)

    const meds = results.find((r) => r.caseId === MEDS)!
    expect(caseScore(meds)).toBe(1) // equivalent
    expect(caseVerdict(meds, T.referenceJudge)).toBe('pass')

    const allergies = results.find((r) => r.caseId === ALLERGIES)!
    expect(caseScore(allergies)).toBe(0.5) // partial < 0.8 → fail
    expect(caseVerdict(allergies, T.referenceJudge)).toBe('fail')

    // Every reference-judge result carries the scorer provenance.
    expect(meds.scorers).toEqual(['reference-judge'])
  })

  it('structured-diff: only the list-extraction case has a key; the rest are excluded', () => {
    const cases = loadBenchCases()
    const details = buildStructuredDiffDetails(cases)
    const medsDetail = details.find((d) => d.caseId === MEDS)!
    expect(medsDetail.score).toBe(1) // expected list == actual list → F1 1.0

    const results = buildBenchResults('structured-diff', cases, 'strict', FALLBACK_THRESHOLDS)
    const meds = results.find((r) => r.caseId === MEDS)!
    expect(caseScore(meds)).toBe(1)

    const allergies = results.find((r) => r.caseId === ALLERGIES)!
    // No structured answer key → excluded from the denominator (not a silent zero).
    expect(allergies.excluded).toBe(true)
    expect(caseScore(allergies)).toBeNull()
  })

  it('intent-label overrides flip a case without mutating the committed fixture', () => {
    const cases = loadBenchCases()
    const T = FALLBACK_THRESHOLDS
    const base = buildBenchResults('faithfulness', cases, 'strict', T)
    const baseMeds = base.find((r) => r.caseId === MEDS)!
    expect(baseMeds.intentLabel).toBe('pass')

    const flipped = buildBenchResults('faithfulness', cases, 'strict', T, { [MEDS]: 'fail' })
    expect(flipped.find((r) => r.caseId === MEDS)!.intentLabel).toBe('fail')
    // The committed source is untouched — a fresh build still reads pass.
    const rebuilt = buildBenchResults('faithfulness', cases, 'strict', T)
    expect(rebuilt.find((r) => r.caseId === MEDS)!.intentLabel).toBe('pass')
  })
})
