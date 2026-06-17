// ── Worked-example REPLAY engine (N13b) ──────────────────────────────────────
//
// Pure, deterministic transforms from a committed `NotebookExampleArtifact` into
// the view models the notebook surface renders. There is ZERO network and ZERO
// model call here — the golden leg's grade is RECOMPUTED with the deterministic
// grader (`replayGoldenGrade`) and the judge leg's verdict is the RECORDED
// `{pass, reason}` replayed verbatim (`replayJudgeVerdict`). Opening the worked
// example therefore spends nothing of either metered model (the zero-metered-call
// replay contract).
//
// The leg outputs are shaped as `OutputCardResult` so the existing `OutputCell`
// renders them unchanged: replayed cards are always `done` (the artifact stores
// only finished runs), carry the producing model id from the artifact, and carry
// no streamed context manifest (`context: null`) — nothing is fabricated.

import {
  failingGoldenCases,
  erroredVerdicts,
  replayGoldenGrade,
  replayJudgeVerdict,
  type GoldenLeg,
  type JudgeLeg,
  type GoldenLegCase,
  type JudgeLegCase,
  type NotebookExampleArtifact,
  type ReplayedVerdict,
} from './example-artifact'
import type { GoldenGrade } from './goldenGrade'
import type { OutputCardResult } from './useNotebookRun'
import type { NotebookPatient } from './types'

/** One replayed golden row: the captured output + its recomputed deterministic grade. */
export interface ReplayedGoldenRow {
  patientId: string
  patientName: string
  output: string
  model: string
  /** The hand-authored golden answer (what the output is graded against). */
  golden: string
  grade: GoldenGrade
}

/** One replayed judge row: the captured prose output + its recorded verdict (replayed). */
export interface ReplayedJudgeRow {
  patientId: string
  patientName: string
  output: string
  model: string
  /** The producing judge model id; null on an errored (un-run / failed) verdict. */
  judgeModel: string | null
  verdict: ReplayedVerdict
}

/** A leg ready to render: ordered patient ids, output cards, and a synthetic roster. */
export interface ReplayedLeg<Row> {
  prompt: string
  /** Patient ids in artifact order. */
  order: string[]
  /** `OutputCardResult` per patient, keyed by id — feeds the existing `OutputCell`. */
  results: Record<string, OutputCardResult>
  /** A minimal patient roster (id + name) so cards label correctly. */
  patientsById: Map<string, NotebookPatient>
  /** The per-patient eval rows (golden grades or judge verdicts), in order. */
  rows: Row[]
}

/** A minimal `NotebookPatient` carrying only what a replayed card needs (id + name). */
function syntheticPatient(patientId: string, name: string): NotebookPatient {
  return {
    id: patientId,
    name,
    // No live grounding is replayed — the artifact stores outputs, not records.
    record: '',
    recordTokens: 0,
    age: null,
    sex: '',
    conditionCount: 0,
  }
}

/** A finished, model-stamped output card for a replayed case — never streaming, no context. */
function doneCard(patientId: string, output: string, model: string): OutputCardResult {
  return { patientId, status: 'done', output, model, context: null }
}

/** Replay the GOLDEN leg: recompute each grade deterministically (no model call). */
export function replayGoldenLeg(golden: GoldenLeg): ReplayedLeg<ReplayedGoldenRow> {
  const order: string[] = []
  const results: Record<string, OutputCardResult> = {}
  const patientsById = new Map<string, NotebookPatient>()
  const rows: ReplayedGoldenRow[] = []

  for (const c of golden.cases) {
    order.push(c.patientId)
    results[c.patientId] = doneCard(c.patientId, c.output, c.model)
    patientsById.set(c.patientId, syntheticPatient(c.patientId, c.patientName))
    rows.push({
      patientId: c.patientId,
      patientName: c.patientName,
      output: c.output,
      model: c.model,
      golden: c.golden,
      grade: replayGoldenGrade(c),
    })
  }
  return { prompt: golden.prompt, order, results, patientsById, rows }
}

/** Replay the JUDGE leg: replay each recorded single-call criteria verdict verbatim. */
export function replayJudgeLeg(judge: JudgeLeg): ReplayedLeg<ReplayedJudgeRow> {
  const order: string[] = []
  const results: Record<string, OutputCardResult> = {}
  const patientsById = new Map<string, NotebookPatient>()
  const rows: ReplayedJudgeRow[] = []

  for (const c of judge.cases) {
    order.push(c.patientId)
    results[c.patientId] = doneCard(c.patientId, c.output, c.model)
    patientsById.set(c.patientId, syntheticPatient(c.patientId, c.patientName))
    rows.push({
      patientId: c.patientId,
      patientName: c.patientName,
      output: c.output,
      model: c.model,
      judgeModel: c.judgeModel,
      verdict: replayJudgeVerdict(c),
    })
  }
  return { prompt: judge.prompt, order, results, patientsById, rows }
}

/** The full replayed worked example — both legs plus the teaching-moment summary. */
export interface ReplayedExample {
  description: string
  generatedAt: string
  models: { generation: string; judge: string }
  golden: ReplayedLeg<ReplayedGoldenRow>
  judge: ReplayedLeg<ReplayedJudgeRow>
  /** The criteria the judge leg's verdicts were ruled against (the pinned text). */
  criteria: string
  /** Patient ids whose recomputed golden grade is `fail` (the load-bearing teaching moment). */
  failingGoldenIds: string[]
  /** Patient ids whose recorded judge verdict is errored (the load-bearing teaching moment). */
  erroredVerdictIds: string[]
}

/** Replay the whole artifact — both legs + the two teaching-moment id lists. */
export function replayExample(artifact: NotebookExampleArtifact): ReplayedExample {
  return {
    description: artifact.description,
    generatedAt: artifact.generatedAt,
    models: artifact.models,
    golden: replayGoldenLeg(artifact.golden),
    judge: replayJudgeLeg(artifact.judge),
    criteria: artifact.judge.criteria,
    failingGoldenIds: failingGoldenCases(artifact.golden).map((c: GoldenLegCase) => c.patientId),
    erroredVerdictIds: erroredVerdicts(artifact.judge).map((c: JudgeLegCase) => c.patientId),
  }
}
