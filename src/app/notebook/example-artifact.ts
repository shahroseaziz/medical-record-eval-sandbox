// ── Worked-example artifact contract (N13a) ──────────────────────────────────
//
// The shape, validators, and CLIENT-SIDE replay helpers for the committed
// worked-example artifact (`example/notebook-example.json`). This module is the
// SINGLE source of truth for the artifact, shared by three consumers:
//
//   1. the maintainer generator (`scripts/gen-notebook-example.ts`) — assembles
//      the artifact against the LIVE engine, then calls `assertTeachingConditions`
//      and refuses to write unless BOTH teaching moments are present;
//   2. the N13b loader — replays the artifact CLIENT-SIDE on `?example=1` with
//      ZERO metered calls (see the replay contract below); and
//   3. the N13b CI integrity gate — re-derives the teaching conditions + sha256
//      from the committed bytes.
//
// This file is intentionally dependency-light and CLIENT-SAFE: it imports only the
// pure, deterministic golden grader (`./goldenGrade`). It MUST NOT import the
// Anthropic SDK or any server-only module, so the N13b client loader can import it
// directly without dragging a judge client into the browser bundle. The sha256
// sidecar is computed by the generator / CI in Node (node:crypto), never here.
//
// ── Zero-metered-call replay contract (COLLATERAL for N13b) ───────────────────
//
// The artifact replays with NO model calls of either kind:
//   • GOLDEN leg — the golden grade is DETERMINISTIC. The artifact stores the
//     captured model `output` and the hand-authored `golden`; the loader recomputes
//     the verdict with `replayGoldenGrade` (a pure call into `gradeGolden`). No
//     verdict is stored — recomputation is the single source, so the line the loader
//     paints can never drift from the committed inputs.
//   • JUDGE leg — the criteria verdict was a METERED call when the maintainer ran
//     the generator, so its result is RECORDED (`{pass, reason}`) and the loader
//     replays the recording verbatim — it never re-calls the judge. An ERRORED
//     verdict records the ABSENCE of a verdict (`{errored:true}`) and carries NO
//     pass/reason: replay renders the "judge errored — not scored" state and never
//     fabricates a ruling.
// Net: opening the worked example spends nothing. Both teaching moments — a failing
// golden row and an errored judge verdict — are load-bearing and are asserted at
// generation time so a shipped artifact can never be missing them.

import { gradeGolden, type GoldenGrade } from './goldenGrade'

// ── Paths + version (the committed convention) ───────────────────────────────

/** Schema version literal stamped into the artifact and checked on load. */
export const EXAMPLE_SCHEMA_VERSION = 'mres.nb.example.v1'

/** Committed artifact path (repo-relative). The maintainer commits this file. */
export const EXAMPLE_ARTIFACT_PATH = 'example/notebook-example.json'

/**
 * Committed sha256 sidecar path (repo-relative). The sidecar is `sha256sum`-format:
 * `<hex>␠␠example/notebook-example.json\n`, so `sha256sum -c` verifies it directly.
 * N13b's CI gate fails if the artifact's hash changes without an explicit bump.
 */
export const EXAMPLE_SHA256_PATH = 'example/notebook-example.json.sha256'

// ── Artifact shape ───────────────────────────────────────────────────────────

/**
 * One GOLDEN-leg case: a captured live extraction output plus the hand-authored
 * golden it is graded against. The grade itself is NOT stored — it is recomputed
 * deterministically by `replayGoldenGrade`, so the committed inputs are the only
 * source of truth.
 */
export interface GoldenLegCase {
  patientId: string
  patientName: string
  /** The model's captured JSON extraction output, verbatim from the live run. */
  output: string
  /** The producing generation model id, stamped from lib/models at generation time. */
  model: string
  /** The hand-authored golden answer (JSON text) the output is graded against. */
  golden: string
}

/** The GOLDEN leg: one extraction prompt, graded against per-patient goldens. */
export interface GoldenLeg {
  /** The extraction prompt (the worked example's `WORKED_PROMPT`). */
  prompt: string
  cases: GoldenLegCase[]
}

/**
 * A recorded judge verdict. An errored verdict carries NO pass/reason — the
 * generator never fabricates a ruling to fill the errored slot; it records the
 * absence of one.
 */
export type RecordedVerdict =
  | { errored: true }
  | { errored: false; pass: boolean; reason: string }

/** One JUDGE-leg case: a captured live prose output + its recorded criteria verdict. */
export interface JudgeLegCase {
  patientId: string
  patientName: string
  /** The captured live prose output the judge ruled on. */
  output: string
  /** The producing generation model id for the prose output. */
  model: string
  /** The recorded single-call criteria verdict (or errored). */
  verdict: RecordedVerdict
  /** The producing judge model id; null on an errored (un-run / failed) verdict. */
  judgeModel: string | null
}

/** The JUDGE leg: a prose-output prompt + criteria, judged per patient. */
export interface JudgeLeg {
  /** The prose-output query asked of each chart. */
  prompt: string
  /** The acceptance criteria (the worked example's `WORKED_CRITERIA`), single-call format. */
  criteria: string
  cases: JudgeLegCase[]
}

/** The full committed worked-example artifact — BOTH legs. */
export interface NotebookExampleArtifact {
  schemaVersion: typeof EXAMPLE_SCHEMA_VERSION
  /** Human-facing one-liner describing what the example teaches. */
  description: string
  /** ISO timestamp the maintainer generated the artifact. */
  generatedAt: string
  /** The producing model ids (generation + judge), from lib/models. */
  models: { generation: string; judge: string }
  golden: GoldenLeg
  judge: JudgeLeg
}

// ── Named errors (the load-bearing guard) ────────────────────────────────────

/** Base class for every artifact-integrity failure. */
export class ExampleArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExampleArtifactError'
  }
}

/** The golden leg has no cases — nothing to grade. */
export class EmptyGoldenLegError extends ExampleArtifactError {
  constructor() {
    super('Worked example invalid: the GOLDEN leg has no cases. Generate ≥1 golden-graded patient.')
    this.name = 'EmptyGoldenLegError'
  }
}

/** The judge leg has no cases — nothing to judge. */
export class EmptyJudgeLegError extends ExampleArtifactError {
  constructor() {
    super('Worked example invalid: the JUDGE leg has no cases. Generate ≥1 judged patient.')
    this.name = 'EmptyJudgeLegError'
  }
}

/** The committed artifact bytes did not parse into the expected shape. */
export class MalformedArtifactError extends ExampleArtifactError {
  constructor(detail: string) {
    super(`Worked example artifact is malformed: ${detail}`)
    this.name = 'MalformedArtifactError'
  }
}

/**
 * No golden row FAILS. The failing-golden row is a load-bearing teaching moment
 * ("a mismatch is a lead"); the generator refuses to ship without one and NEVER
 * tampers with a golden to manufacture a failure.
 */
export class MissingFailingGoldenError extends ExampleArtifactError {
  constructor() {
    super(
      'Worked example missing its teaching moment: every golden row PASSES. ' +
        '≥1 FAILING golden row is required. Do NOT edit a golden to force a failure — ' +
        'change the patient selection / prompt until the live model genuinely gets one wrong.',
    )
    this.name = 'MissingFailingGoldenError'
  }
}

/**
 * No judge verdict is ERRORED. The errored verdict is a load-bearing teaching
 * moment (the judge can fail; that patient is left unscored); the generator
 * refuses to ship without one and NEVER fabricates a verdict to fill the slot.
 */
export class MissingErroredVerdictError extends ExampleArtifactError {
  constructor() {
    super(
      'Worked example missing its teaching moment: no judge verdict is ERRORED. ' +
        '≥1 ERRORED verdict is required so the example teaches the "judge errored — not scored" state.',
    )
    this.name = 'MissingErroredVerdictError'
  }
}

// ── Replay helpers (CLIENT-SIDE, zero metered calls) ─────────────────────────

/**
 * Deterministically grade one golden-leg case — the GOLDEN leg's replay. Pure: a
 * call into the shared `gradeGolden` normalization contract, no I/O. `outputReady`
 * is always true here (the artifact only stores finished runs).
 */
export function replayGoldenGrade(c: GoldenLegCase): GoldenGrade {
  return gradeGolden(c.golden, c.output, true)
}

/** Every golden-leg case whose recomputed grade is `fail`. */
export function failingGoldenCases(golden: GoldenLeg): GoldenLegCase[] {
  return golden.cases.filter((c) => replayGoldenGrade(c).state === 'fail')
}

/** Every judge-leg case whose recorded verdict is errored. */
export function erroredVerdicts(judge: JudgeLeg): JudgeLegCase[] {
  return judge.cases.filter((c) => c.verdict.errored)
}

/** A replayed judge verdict for the UI — pass/reason, or errored with both null. */
export interface ReplayedVerdict {
  errored: boolean
  /** Null only when errored — never fabricated. */
  pass: boolean | null
  /** Null only when errored — never fabricated. */
  reason: string | null
}

/**
 * Replay one judge-leg case's verdict — the JUDGE leg's replay. Returns the
 * RECORDED verdict verbatim (no judge call); an errored verdict yields
 * `{errored:true, pass:null, reason:null}` so the loader renders "not scored"
 * rather than inventing a ruling.
 */
export function replayJudgeVerdict(c: JudgeLegCase): ReplayedVerdict {
  if (c.verdict.errored) return { errored: true, pass: null, reason: null }
  return { errored: false, pass: c.verdict.pass, reason: c.verdict.reason }
}

// ── Teaching-condition guard ─────────────────────────────────────────────────

/**
 * Assert BOTH teaching moments are present, throwing a NAMED error otherwise. This
 * is the guard the generator runs before writing the artifact — it never silently
 * conforms or fabricates to satisfy the shape; a missing teaching moment is a hard,
 * named failure. Re-derived by N13b's CI gate from the committed bytes.
 *
 * Conditions:
 *   • the golden leg has ≥1 case AND ≥1 of them FAILS its golden;
 *   • the judge leg has ≥1 case AND ≥1 verdict is ERRORED.
 */
export function assertTeachingConditions(artifact: NotebookExampleArtifact): void {
  if (artifact.golden.cases.length === 0) throw new EmptyGoldenLegError()
  if (artifact.judge.cases.length === 0) throw new EmptyJudgeLegError()
  if (failingGoldenCases(artifact.golden).length === 0) throw new MissingFailingGoldenError()
  if (erroredVerdicts(artifact.judge).length === 0) throw new MissingErroredVerdictError()
}

// ── Serialization (stable bytes for the sha256 sidecar) ──────────────────────

/**
 * Serialize the artifact to its canonical committed bytes: pretty-printed JSON with
 * a trailing newline. The sha256 sidecar is computed over EXACTLY this string, so
 * the generator and N13b's CI gate hash the same bytes.
 */
export function serializeArtifact(artifact: NotebookExampleArtifact): string {
  return JSON.stringify(artifact, null, 2) + '\n'
}

// ── Runtime validation (parse committed bytes → typed artifact) ───────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function asString(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new MalformedArtifactError(`${where} must be a string`)
  return v
}

function parseRecordedVerdict(v: unknown, where: string): RecordedVerdict {
  if (!isRecord(v)) throw new MalformedArtifactError(`${where} must be an object`)
  if (v.errored === true) return { errored: true }
  if (v.errored === false) {
    if (typeof v.pass !== 'boolean') throw new MalformedArtifactError(`${where}.pass must be boolean`)
    return { errored: false, pass: v.pass, reason: asString(v.reason, `${where}.reason`) }
  }
  throw new MalformedArtifactError(`${where}.errored must be true or false`)
}

function parseGoldenCase(v: unknown, i: number): GoldenLegCase {
  if (!isRecord(v)) throw new MalformedArtifactError(`golden.cases[${i}] must be an object`)
  return {
    patientId: asString(v.patientId, `golden.cases[${i}].patientId`),
    patientName: asString(v.patientName, `golden.cases[${i}].patientName`),
    output: asString(v.output, `golden.cases[${i}].output`),
    model: asString(v.model, `golden.cases[${i}].model`),
    golden: asString(v.golden, `golden.cases[${i}].golden`),
  }
}

function parseJudgeCase(v: unknown, i: number): JudgeLegCase {
  if (!isRecord(v)) throw new MalformedArtifactError(`judge.cases[${i}] must be an object`)
  const verdict = parseRecordedVerdict(v.verdict, `judge.cases[${i}].verdict`)
  // An errored verdict carries NO judge model id (the call never settled); a
  // settled verdict must stamp one. We honour whatever the artifact recorded but
  // require the type to be string-or-null so the contract can't silently soften.
  const judgeModel =
    v.judgeModel === null ? null : asString(v.judgeModel, `judge.cases[${i}].judgeModel`)
  return {
    patientId: asString(v.patientId, `judge.cases[${i}].patientId`),
    patientName: asString(v.patientName, `judge.cases[${i}].patientName`),
    output: asString(v.output, `judge.cases[${i}].output`),
    model: asString(v.model, `judge.cases[${i}].model`),
    verdict,
    judgeModel,
  }
}

/**
 * Parse untrusted bytes (a fetched / read-from-disk artifact) into a typed
 * `NotebookExampleArtifact`, throwing a NAMED `MalformedArtifactError` on any shape
 * violation. Shared by the N13b client loader and the CI integrity gate so both
 * reject the same malformed inputs identically. Does NOT assert the teaching
 * conditions — that is `assertTeachingConditions`, run separately.
 */
export function parseExampleArtifact(raw: unknown): NotebookExampleArtifact {
  if (!isRecord(raw)) throw new MalformedArtifactError('top-level value is not an object')
  if (raw.schemaVersion !== EXAMPLE_SCHEMA_VERSION) {
    throw new MalformedArtifactError(
      `schemaVersion must be "${EXAMPLE_SCHEMA_VERSION}", got ${JSON.stringify(raw.schemaVersion)}`,
    )
  }
  if (!isRecord(raw.golden)) throw new MalformedArtifactError('golden leg is missing')
  if (!isRecord(raw.judge)) throw new MalformedArtifactError('judge leg is missing')
  if (!Array.isArray(raw.golden.cases)) throw new MalformedArtifactError('golden.cases must be an array')
  if (!Array.isArray(raw.judge.cases)) throw new MalformedArtifactError('judge.cases must be an array')
  if (!isRecord(raw.models)) throw new MalformedArtifactError('models is missing')

  return {
    schemaVersion: EXAMPLE_SCHEMA_VERSION,
    description: asString(raw.description, 'description'),
    generatedAt: asString(raw.generatedAt, 'generatedAt'),
    models: {
      generation: asString(raw.models.generation, 'models.generation'),
      judge: asString(raw.models.judge, 'models.judge'),
    },
    golden: {
      prompt: asString(raw.golden.prompt, 'golden.prompt'),
      cases: raw.golden.cases.map((c, i) => parseGoldenCase(c, i)),
    },
    judge: {
      prompt: asString(raw.judge.prompt, 'judge.prompt'),
      criteria: asString(raw.judge.criteria, 'judge.criteria'),
      cases: raw.judge.cases.map((c, i) => parseJudgeCase(c, i)),
    },
  }
}
