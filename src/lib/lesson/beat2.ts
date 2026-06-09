import beat2Data from '@/example/lesson-beat2.json'
import { scoreStructuredDiff } from '@/lib/eval/scorers/structured-diff'
import { buildReplayedReferenceResult } from '@/lib/eval/scorers/reference-judge'
import type {
  EvalCase,
  ReferenceJudgeResult,
  ReferenceVerdict,
  StructuredDiffResult,
} from '@/lib/eval/types'

/**
 * Beat 2 — the prose contrast of the guided lesson.
 *
 * Beat 1 graded a STRUCTURED extraction (a medication list) with a deterministic
 * structured diff, and it worked: per-field alignment caught a real dose error.
 * Beat 2 asks a different kind of question — "is this patient's diabetes under
 * control?" — whose correct answer is a PROSE clinical judgment, not a field list.
 *
 * Run Beat 1's instrument on that prose and it does not score low — it cannot run
 * at all: the structured diff demands JSON fields to align, and prose has none, so
 * `scoreStructuredDiff` returns `errored: true` / `score: null`. That visible
 * failure is the motivation to reach for the REFERENCE JUDGE, which compares the
 * answer's MEANING against an expected-prose answer key and returns "equivalent".
 *
 * Both results are produced offline with NO model call (rule 20: deterministic
 * test seam):
 *   - the structured diff is a pure function, recomputed in-process;
 *   - the reference verdict is a COMMITTED record-replay fixture
 *     (`replayReferenceJudge`), turned into a result by `buildReplayedReferenceResult`
 *     — byte-identical on every load, never re-judged live.
 *
 * The fixture also carries a `fallibilitySeed`: the reference judge is a second
 * fallible opinion, not an oracle. It inherits the blind spots of the expected
 * prose it compares against — the seed that Beat 3 pays off when a judge is fooled.
 */

interface Beat2Fixture {
  version: number
  description: string
  caseId: string
  taskPrompt: string
  output: string
  expectedProse: string
  expectedStructured: Record<string, unknown>
  replayReferenceJudge: { verdict: ReferenceVerdict; reason: string }
  fallibilitySeed: string
  rationale: string
}

const DATA = beat2Data as Beat2Fixture

export interface LessonBeat2Contrast {
  caseId: string
  taskPrompt: string
  /** The committed prose model output both instruments are pointed at (synthetic patient). */
  output: string
  /** The hand-authored expected prose answer key the reference judge compares against. */
  expectedProse: string
  /** The structured target a naive reviewer might try to diff prose against. */
  expectedStructured: Record<string, unknown>
  /** Beat 1's instrument on prose: errored / score=null — it has no fields to align. */
  diff: StructuredDiffResult
  /** The reference judge resolving the prose: "equivalent" (committed record-replay). */
  judge: ReferenceJudgeResult
  /** Judge-fallibility seed — no oracle framing; pays off in Beat 3. */
  fallibilitySeed: string
}

/**
 * Load Beat 2, computing both scorer results deterministically from the committed
 * fixture. Identical on every call — no inputs, no model, no randomness.
 */
export function loadLessonBeat2(): LessonBeat2Contrast {
  const evalCase: EvalCase = {
    id: DATA.caseId,
    patientId: 'lesson',
    query: DATA.taskPrompt,
    output: DATA.output,
    mode: 'stuff',
    expectedStructured: DATA.expectedStructured,
    expectedProse: DATA.expectedProse,
  }

  // Beat 1's deterministic diff, pointed at prose: it cannot parse fields from a
  // clinical-judgment sentence, so it errors rather than producing a misleading score.
  const diff = scoreStructuredDiff(evalCase)

  // The reference judge, from a committed verdict (record-replay): same meaning,
  // different words -> "equivalent". Never re-judged live.
  const judge = buildReplayedReferenceResult(
    DATA.output,
    DATA.expectedProse,
    DATA.replayReferenceJudge.verdict,
    DATA.replayReferenceJudge.reason,
  )

  return {
    caseId: DATA.caseId,
    taskPrompt: DATA.taskPrompt,
    output: DATA.output,
    expectedProse: DATA.expectedProse,
    expectedStructured: DATA.expectedStructured,
    diff,
    judge,
    fallibilitySeed: DATA.fallibilitySeed,
  }
}
