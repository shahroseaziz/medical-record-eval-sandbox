import beat3Data from '@/example/lesson-beat3.json'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'

/**
 * Beat 3 — faithfulness capstone data.
 *
 * The capstone runs entirely on COMMITTED data: each case carries a faithfulness
 * verdict for the SAME output under two rubric variants (`strict` / `lenient`).
 * Switching the rubric re-derives the score from the committed per-claim verdicts
 * — deterministically, with no model call — so the lesson is offline, free, and
 * byte-stable on every load (rule 20: deterministic test seams).
 *
 * Unlike Beats 1 (structured diff vs an expected list) and 2 (reference judge vs
 * expected prose), Beat 3 has NO answer key. The judge only checks whether each
 * atomic claim is grounded in the retrieved context — that is the whole point of
 * a faithfulness check (rule 14), and the reason it can be fooled by a plausible
 * hallucination the way the strict/lenient allergy case demonstrates.
 */

export type RubricVariant = 'strict' | 'lenient'

export interface LessonClaim {
  claim: string
  verdict: 'supported' | 'unsupported' | 'partial'
  rationale: string
}

export interface LessonGroundingChunk {
  section: string
  text: string
}

export interface LessonBeat3Case {
  caseId: string
  /** The label YOU assign before seeing the judge's verdict. */
  intentLabel: 'pass' | 'fail'
  taskPrompt: string
  output: string
  /** Why the case was designed pass/fail — the human's reasoning. */
  designedReason: string
  /** The retrieved context the judge grounds against — there is no answer key. */
  grounding: LessonGroundingChunk[]
  claims: Record<RubricVariant, LessonClaim[]>
}

export interface LessonBeat3Data {
  description: string
  rubrics: Record<RubricVariant, string>
  cases: LessonBeat3Case[]
}

const DATA = beat3Data as LessonBeat3Data

/**
 * Faithfulness score for a set of claims: supported / total. `partial` and
 * `unsupported` both count as NOT supported — identical to the live scorer
 * (`scoreFaithfulness` in src/lib/eval/scorers/faithfulness.ts), so the committed
 * lesson math can never drift from production.
 */
export function faithfulnessScore(claims: LessonClaim[]): number {
  if (claims.length === 0) return 1.0
  const supported = claims.filter((c) => c.verdict === 'supported').length
  return supported / claims.length
}

/** The committed capstone data (rubric texts + cases). */
export function loadLessonBeat3(): LessonBeat3Data {
  return DATA
}

/**
 * Project the committed cases into the scorer-agnostic `UserRunCaseResult[]` the
 * DisagreementTable / `computeUserAgreement` consume, for one rubric variant.
 *
 * `intentLabelOverrides` lets the lesson surface the "you label it" interaction:
 * the learner can flip a case's pass/fail label and watch the judge agree or
 * disagree, without mutating the committed fixture.
 */
export function buildBeat3Results(
  rubric: RubricVariant,
  intentLabelOverrides: Record<string, 'pass' | 'fail'> = {},
): UserRunCaseResult[] {
  return DATA.cases.map((c) => {
    const claims = c.claims[rubric]
    return {
      caseId: c.caseId,
      intentLabel: intentLabelOverrides[c.caseId] ?? c.intentLabel,
      faithfulnessScore: faithfulnessScore(claims),
      zeroClaimFlag: false,
      claims,
      output: c.output,
      taskPrompt: c.taskPrompt,
    }
  })
}

/** Mean faithfulness score across all cases for a rubric — the headline number
 * that visibly moves when the rubric is swapped. */
export function meanBeat3Score(rubric: RubricVariant): number {
  const scores = DATA.cases.map((c) => faithfulnessScore(c.claims[rubric]))
  return scores.reduce((a, b) => a + b, 0) / scores.length
}
