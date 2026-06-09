import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ReferenceVerdict, StructuredFieldDiff } from './eval/types'

/**
 * Guided-lesson data loader.
 *
 * The correctness lesson runs entirely on COMMITTED generation: its two beats
 * read pre-computed scorer results from `evals/results/seed-baseline.json` (the
 * `lesson-marisela-medications-structured-diff` case) and never call a model.
 *
 *   Beat-1 — a deterministic structured diff of the committed extraction against
 *            the hand-authored expected list (F1, per-field rows).
 *   Beat-2 — the committed reference-judge verdict comparing the same output
 *            against the expected prose (record-replay; see scripts/generate-baseline.ts).
 *
 * Because both inputs are committed and the structured diff is deterministic,
 * the lesson produces IDENTICAL results on every load — no live generation, so
 * the diff cannot flap on formatting drift.
 */
export const LESSON_CASE_ID = 'lesson-marisela-medications-structured-diff'

const BASELINE_PATH = join(process.cwd(), 'evals/results/seed-baseline.json')
const GOLDEN_PATH = join(process.cwd(), 'evals/golden/seed-cases.json')

export interface LessonBeat1 {
  /** F1 over field-level matches (deterministic). */
  score: number
  matchCount: number
  mismatchCount: number
  missingCount: number
  extraCount: number
  precision: number
  recall: number
  fields: StructuredFieldDiff[]
  blindSpots: string[]
}

export interface LessonBeat2 {
  verdict: ReferenceVerdict
  /** 1.0 / 0.5 / 0.0 for equivalent / partial / divergent. */
  score: number
  reason: string
  /** Redacted (sha256+len) judge prompt safe to display — no PHI/PII. */
  judgePrompt: string
  /** Hand-authored expected prose the judge compared against. */
  expectedProse: string
}

export interface LessonData {
  caseId: string
  taskPrompt: string
  /** The committed model output both beats grade (synthetic patient — safe to show). */
  output: string
  beat1: LessonBeat1
  beat2: LessonBeat2
}

interface BaselineScorerResult {
  scorer: string
  score: number | null
  [k: string]: unknown
}

interface BaselineCase {
  caseId: string
  trace: { output: string }
  scorerResults: BaselineScorerResult[]
}

interface SeedCase {
  id: string
  taskPrompt: string
  preauthoredOutput?: string
  expectedProse?: string
}

/**
 * Load the committed lesson data. Returns null when the baseline has not been
 * generated yet or the lesson case / its scorer results are absent — callers
 * render a fallback rather than crashing the page.
 */
export function loadLesson(): LessonData | null {
  let baseline: { cases: BaselineCase[] }
  let seedCases: SeedCase[]
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    seedCases = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
  } catch {
    return null
  }

  const bc = baseline.cases?.find((c) => c.caseId === LESSON_CASE_ID)
  const sc = seedCases?.find((c) => c.id === LESSON_CASE_ID)
  if (!bc || !sc) return null

  const diff = bc.scorerResults.find((r) => r.scorer === 'structured-diff')
  const judge = bc.scorerResults.find((r) => r.scorer === 'reference-judge')
  if (!diff || diff.score == null || !judge || judge.score == null) return null

  const beat1: LessonBeat1 = {
    score: diff.score,
    matchCount: Number(diff.matchCount ?? 0),
    mismatchCount: Number(diff.mismatchCount ?? 0),
    missingCount: Number(diff.missingCount ?? 0),
    extraCount: Number(diff.extraCount ?? 0),
    precision: Number(diff.precision ?? 0),
    recall: Number(diff.recall ?? 0),
    fields: (diff.fields as StructuredFieldDiff[]) ?? [],
    blindSpots: (diff.blindSpots as string[]) ?? [],
  }

  const beat2: LessonBeat2 = {
    verdict: judge.verdict as ReferenceVerdict,
    score: judge.score,
    reason: String(judge.reason ?? ''),
    judgePrompt: String(judge.judgePrompt ?? ''),
    expectedProse: sc.expectedProse ?? '',
  }

  return {
    caseId: LESSON_CASE_ID,
    taskPrompt: sc.taskPrompt,
    output: sc.preauthoredOutput ?? bc.trace.output,
    beat1,
    beat2,
  }
}
