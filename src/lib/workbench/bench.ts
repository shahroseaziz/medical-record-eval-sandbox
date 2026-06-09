// ── Open-workbench data model ────────────────────────────────────────────────
//
// R11 — the open bench. Prompt, cases, and evaluator are free knobs, and the
// surface is never empty: it lands pre-loaded from the lesson's last state
// (Beat 3, the faithfulness capstone) so there are results on first paint.
//
// The bench reuses the lesson's COMMITTED capstone cases (`loadLessonBeat3`) as
// its starting golden set, so "pre-loaded from the lesson's last state" is literal
// — the same synthetic patients, grounding, and outputs the learner just saw.
//
// The evaluator is a free knob with three types. Faithfulness needs NO answer key
// (rule 14: it checks each atomic claim against the grounding), so its surface has
// no "expected" column — only grounding + agreement. The other two evaluators DO
// need an answer key, supplied here as a committed annex authored from the same
// grounding. Everything below is deterministic and offline (rule 20); the one LIVE
// knob is the generation prompt, which re-runs generation through /api/run (R1).

import {
  loadLessonBeat3,
  buildBeat3Results,
  faithfulnessScore,
  type RubricVariant,
  type LessonGroundingChunk,
} from '@/lib/lesson/beat3'
import { scoreStructuredDiff } from '@/lib/eval/scorers/structured-diff'
import type { EvalCase, ReferenceVerdict, StructuredFieldDiff } from '@/lib/eval/types'
import { scoreRow, type FieldScoreOutcome } from '@/lib/eval/row-aggregate'
import { toUserRunCaseResult, DEFAULT_PASS_THRESHOLD } from '@/lib/eval/user-agreement'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'
import type { Thresholds } from '@/lib/eval/thresholds'

export type { RubricVariant }

/** The evaluator palette — the three scorer types the bench can grade with. */
export const EVALUATORS = ['faithfulness', 'reference-judge', 'structured-diff'] as const
export type EvaluatorType = (typeof EVALUATORS)[number]

export const EVALUATOR_LABEL: Record<EvaluatorType, string> = {
  faithfulness: 'Faithfulness (no answer key)',
  'reference-judge': 'Reference judge (expected prose)',
  'structured-diff': 'Structured diff (expected list)',
}

/**
 * Whether an evaluator grades against a hand-authored answer key (an "expected"
 * value). Faithfulness does NOT — that is the surface-reshaping distinction: a
 * faithfulness run shows grounding + claims, never an expected column.
 */
export function evaluatorHasAnswerKey(e: EvaluatorType): boolean {
  return e !== 'faithfulness'
}

interface StructuredMedList {
  medications: Array<{ name: string; dose?: string }>
}

/**
 * Answer-key annex. The lesson's faithfulness cases carry no answer key by design,
 * so the bench supplies one per case for the two evaluators that need it. Authored
 * from the SAME committed grounding — synthetic, deterministic, offline.
 *
 *  - `expectedProse`      — the ideal answer the reference judge compares against.
 *  - `referenceVerdict`   — the committed meaning-equivalence verdict (record-replay,
 *                           rule 20). 1.0 / 0.5 / 0.0 for equivalent / partial / divergent.
 *  - `expectedStructured` / `actualStructured` — only the list-extraction case has a
 *    structured answer key; for the others structured-diff is "not applicable".
 */
interface AnswerKey {
  expectedProse: string
  referenceVerdict: ReferenceVerdict
  expectedStructured?: StructuredMedList
  actualStructured?: StructuredMedList
}

const ANSWER_KEYS: Record<string, AnswerKey> = {
  'beat3-medications-pass': {
    expectedProse:
      'The patient takes Lisinopril 10mg daily for hypertension and Atorvastatin 20mg nightly for hyperlipidemia.',
    referenceVerdict: 'equivalent',
    expectedStructured: {
      medications: [
        { name: 'Lisinopril', dose: '10mg' },
        { name: 'Atorvastatin', dose: '20mg' },
      ],
    },
    actualStructured: {
      medications: [
        { name: 'Lisinopril', dose: '10mg' },
        { name: 'Atorvastatin', dose: '20mg' },
      ],
    },
  },
  'beat3-cardiac-hallucination-fail': {
    expectedProse:
      'No cardiac procedures are documented. The record shows only a routine physical exam and a blood draw for a CBC panel.',
    // The output invents a CABG and a stent — meaning diverges entirely.
    referenceVerdict: 'divergent',
  },
  'beat3-allergies-rubric-sensitive-fail': {
    expectedProse:
      'The patient has a documented penicillin allergy (hives) and a sulfa-drug sensitivity (rash). No other allergies are documented.',
    // Penicillin + sulfa are correct, but the aspirin reaction is invented — partial.
    referenceVerdict: 'partial',
  },
  'beat3-problems-threshold-sensitive-pass': {
    expectedProse:
      'The patient has three active problems: type 2 diabetes mellitus, essential hypertension, and hyperlipidemia. The most recent HbA1c is 6.4%.',
    referenceVerdict: 'equivalent',
  },
}

export interface BenchCase {
  caseId: string
  intentLabel: 'pass' | 'fail'
  taskPrompt: string
  output: string
  designedReason: string
  grounding: LessonGroundingChunk[]
  expectedProse: string
  referenceVerdict: ReferenceVerdict
  expectedStructured?: StructuredMedList
  actualStructured?: StructuredMedList
}

/**
 * The bench's starting cases — the lesson's committed capstone cases joined with
 * the answer-key annex. This is the literal "pre-loaded from the lesson's last
 * state" set.
 */
export function loadBenchCases(): BenchCase[] {
  return loadLessonBeat3().cases.map((c) => {
    const key = ANSWER_KEYS[c.caseId]
    return {
      caseId: c.caseId,
      intentLabel: c.intentLabel,
      taskPrompt: c.taskPrompt,
      output: c.output,
      designedReason: c.designedReason,
      grounding: c.grounding,
      expectedProse: key?.expectedProse ?? '',
      referenceVerdict: key?.referenceVerdict ?? 'divergent',
      expectedStructured: key?.expectedStructured,
      actualStructured: key?.actualStructured,
    }
  })
}

/** Assemble the grounding chunks into the single context string a model/judge sees. */
export function assembleGrounding(grounding: LessonGroundingChunk[]): string {
  return grounding.map((g) => `[${g.section}]\n${g.text}`).join('\n\n---\n\n')
}

const VERDICT_SCORE: Record<ReferenceVerdict, number> = {
  equivalent: 1.0,
  partial: 0.5,
  divergent: 0.0,
}

/**
 * Fallback per-scorer thresholds, mirroring the documented config defaults
 * (evals/thresholds.yaml). Only used when the page could not read config (rule 15:
 * the running app always threads the config values in via the `thresholds` prop).
 */
export const FALLBACK_THRESHOLDS: Thresholds = {
  faithfulness: DEFAULT_PASS_THRESHOLD,
  contains: 1.0,
  referenceJudge: 0.8,
  judgeKappaMin: 0.4,
  extractionCompleteness: 0.0,
  structuredDiff: 0.0,
}

/** Per-case structured-diff result for the "expected list" surface. */
export interface StructuredDiffDetail {
  caseId: string
  /** F1 over field diffs; null when the case has no structured answer key. */
  score: number | null
  fields: StructuredFieldDiff[]
  blindSpots: string[]
}

/**
 * Score every bench case under the structured-diff evaluator. Deterministic and
 * client-side (no model call) — diffs each case's committed `actualStructured`
 * against its `expectedStructured`. Cases with no structured answer key score
 * null (surfaced as "not applicable", not a silent zero).
 */
export function buildStructuredDiffDetails(cases: BenchCase[]): StructuredDiffDetail[] {
  return cases.map((c) => {
    if (!c.expectedStructured || !c.actualStructured) {
      return { caseId: c.caseId, score: null, fields: [], blindSpots: [] }
    }
    const evalCase: EvalCase = {
      id: c.caseId,
      patientId: c.caseId,
      query: c.taskPrompt,
      output: '',
      mode: 'stuff',
      expectedStructured: c.expectedStructured as unknown as Record<string, unknown>,
    }
    const r = scoreStructuredDiff(evalCase, c.actualStructured)
    return { caseId: c.caseId, score: r.score, fields: r.fields, blindSpots: r.blindSpots }
  })
}

/**
 * Project the bench cases into scorer-agnostic `UserRunCaseResult[]` for the
 * selected evaluator. This is the single function the surface re-runs whenever a
 * knob (evaluator, rubric, or label) changes.
 *
 *  - faithfulness   → the committed per-claim verdicts under the active rubric
 *                     (delegates to the lesson's `buildBeat3Results`); the red-cell
 *                     aha lives here (the allergies case flips at the lenient rubric).
 *  - reference-judge→ the committed meaning-equivalence verdict, classified against
 *                     the config `referenceJudge` threshold.
 *  - structured-diff→ the deterministic F1 diff, classified against `structuredDiff`.
 *
 * `labelOverrides` lets the learner flip a case's designed pass/fail label and
 * watch agreement move, without mutating the committed fixture.
 */
export function buildBenchResults(
  evaluator: EvaluatorType,
  cases: BenchCase[],
  rubric: RubricVariant,
  thresholds: Thresholds,
  labelOverrides: Record<string, 'pass' | 'fail'> = {},
): UserRunCaseResult[] {
  if (evaluator === 'faithfulness') {
    return buildBeat3Results(rubric, labelOverrides)
  }

  return cases.map((c) => {
    const intentLabel = labelOverrides[c.caseId] ?? c.intentLabel
    let outcome: FieldScoreOutcome
    if (evaluator === 'reference-judge') {
      outcome = {
        field: 'prose',
        scorer: 'reference-judge',
        score: VERDICT_SCORE[c.referenceVerdict],
      }
    } else {
      // structured-diff
      const hasKey = Boolean(c.expectedStructured && c.actualStructured)
      const detail = hasKey ? buildStructuredDiffDetails([c])[0] : null
      outcome = {
        field: 'structured',
        scorer: 'structured-diff',
        score: detail?.score ?? null,
        skipped: !hasKey || detail?.score == null,
      }
    }
    const row = scoreRow(c.caseId, [outcome], thresholds)
    return toUserRunCaseResult(row, {
      intentLabel,
      output: c.output,
      taskPrompt: c.taskPrompt,
    })
  })
}

export { faithfulnessScore }
