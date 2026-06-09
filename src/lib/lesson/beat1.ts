import beat1Data from '@/example/lesson-beat1.json'
import { scoreStructuredDiff } from '@/lib/eval/scorers/structured-diff'
import type { EvalCase, StructuredDiffResult } from '@/lib/eval/types'

/**
 * Beat 1 — correctness with a diff (the intuitive on-ramp).
 *
 * The whole beat runs on COMMITTED data with NO model call:
 *  - `modelOutput` is the SEEDED generation from R7 (the same committed extraction
 *    the `lesson-marisela-medications-structured-diff` case carries; a Vitest drift
 *    guard pins them equal so this beat is genuinely "on seeded generation").
 *  - The learner authors an answer key by choosing a SOURCE — the patient summary
 *    or the full record — and the deterministic structured-diff scorer
 *    (`scoreStructuredDiff`, the real production scorer) grades the seeded output
 *    against that key. No fabricated scores: the diff is recomputed on every call.
 *
 * The lesson's point lives in the gap between the two keys. The summary lists
 * amlodipine at 5 mg (a derived-artifact error); the record documents 2.5 mg.
 * Authoring from the summary yields a green diff against a WRONG reference — the
 * "you trusted an untested key" aha. Authoring from the record catches the model's
 * 5 mg as a real mismatch — "that's the discipline". Because both keys and the
 * output are committed and the scorer is deterministic, every load is byte-stable
 * (rule 20: deterministic test seams).
 */

export type SourcePath = 'summary' | 'record'

export interface Beat1Outcome {
  /** Card tone used to render the outcome (danger = false confidence). */
  tone: 'danger' | 'success'
  headline: string
  body: string
}

export interface LessonBeat1Data {
  description: string
  patientLabel: string
  /** The exact generation prompt that produced `modelOutput` — shown, inspectable. */
  generationPrompt: string
  /** The SEEDED (R7) committed model output both authoring paths grade. */
  modelOutput: string
  /** The visit summary you author a key from — carries the amlodipine dose error. */
  summary: string
  /** The full record (source of truth) — one click away; documents amlodipine 2.5 mg. */
  fullRecord: string
  /** The expected medication list each source yields when you author from it. */
  answerKeys: Record<SourcePath, { medications: { name: string; dose: string }[] }>
  /** The honest payoff for each path. */
  outcomes: Record<SourcePath, Beat1Outcome>
}

const DATA = beat1Data as LessonBeat1Data

/** The committed Beat-1 fixture (prompt, seeded output, summary, record, keys, outcomes). */
export function loadLessonBeat1(): LessonBeat1Data {
  return DATA
}

/**
 * Run the deterministic structured diff of the SEEDED model output against the
 * answer key the learner authored from `source`. This calls the real production
 * scorer — the lesson math can never drift from what ships.
 */
export function diffForSource(source: SourcePath): StructuredDiffResult {
  const evalCase: EvalCase = {
    id: 'lesson-beat1',
    patientId: '',
    query: DATA.generationPrompt,
    output: DATA.modelOutput,
    mode: 'stuff',
    expectedStructured: DATA.answerKeys[source] as Record<string, unknown>,
  }
  return scoreStructuredDiff(evalCase)
}
