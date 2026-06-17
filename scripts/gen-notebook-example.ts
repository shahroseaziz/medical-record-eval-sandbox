/**
 * gen-notebook-example.ts — the worked-example artifact GENERATOR (N13a).
 *
 * A MAINTAINER script that runs against the LIVE engine (Postgres + Anthropic) and
 * produces the committed worked-example artifact `example/notebook-example.json`
 * (+ its `.sha256` sidecar). The artifact holds BOTH legs of the worked example:
 *
 *   1. the GOLDEN leg — the diabetes-extraction `WORKED_PROMPT` run live over the
 *      seeded patients, each output graded DETERMINISTICALLY against a hand-authored
 *      golden; and
 *   2. the JUDGE leg — a prose-output query run live, then ruled on by the single-
 *      call criteria judge against `WORKED_CRITERIA`, INCLUDING one designated
 *      errored verdict (the "judge errored — not scored" teaching moment).
 *
 * The generator REFUSES to write the artifact unless BOTH teaching moments survive
 * (≥1 FAILING golden row AND ≥1 ERRORED judge verdict): it calls
 * `assertTeachingConditions`, which throws a NAMED error and exits non-zero. It
 * NEVER silently conforms or fabricates to satisfy the shape — a missing teaching
 * moment is the maintainer's signal to change the patient selection (golden leg) or
 * confirm the designated errored case (judge leg), not to doctor the data.
 *
 * Committing the generated artifact + sidecar is a MANUAL step (Desk-verified, like
 * the N1 re-seed): this script writes the files; a human runs it against the live
 * engine, confirms the two teaching moments in the output, and commits the result.
 *
 * The artifact replays CLIENT-SIDE with ZERO metered calls (consumed by N13b) — see
 * the replay contract in src/app/notebook/example-artifact.ts.
 *
 * Usage:  ANTHROPIC_API_KEY=… DATABASE_URL=… npm run gen:notebook-example
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withClient } from '../src/lib/db/index.js'
import {
  assembleStuffRecord,
  recordFitsBudget,
  recordTokenEstimate,
  type RecordChunk,
} from '../src/lib/workbench/composer.js'
import { buildPrompt } from '../src/lib/run/prompt.js'
import { scoreCriteriaJudge } from '../src/lib/eval/scorers/criteria-judge.js'
import { GENERATION_MODEL, JUDGE_MODEL } from '../src/lib/models.js'
import { WORKED_PROMPT, WORKED_CRITERIA } from '../src/app/notebook/worked-example.js'
import {
  assertTeachingConditions,
  serializeArtifact,
  failingGoldenCases,
  erroredVerdicts,
  EXAMPLE_ARTIFACT_PATH,
  EXAMPLE_SHA256_PATH,
  EXAMPLE_SCHEMA_VERSION,
  type GoldenLegCase,
  type JudgeLegCase,
  type NotebookExampleArtifact,
} from '../src/app/notebook/example-artifact.js'

// ── Constants ────────────────────────────────────────────────────────────────

const SEED_PATH = join(process.cwd(), 'evals/golden/notebook-example-seed.json')
const ARTIFACT_PATH = join(process.cwd(), EXAMPLE_ARTIFACT_PATH)
const SIDECAR_PATH = join(process.cwd(), EXAMPLE_SHA256_PATH)

// Generation max tokens — matches the notebook generate path. The judge call's
// timeout/budget live inside scoreCriteriaJudge (rule 19).
const GEN_MAX_TOKENS = 1024

// ── Seed shape ───────────────────────────────────────────────────────────────

interface SeedGoldenPatient {
  patientId: string
  golden: string
}
interface SeedJudgePatient {
  patientId: string
  /** When true, this patient's judge verdict is RECORDED as errored (no judge call,
   *  no fabricated ruling) — the designated "judge errored — not scored" teaching case. */
  erroredDemo?: boolean
}
interface ExampleSeed {
  golden: { patients: SeedGoldenPatient[] }
  judge: { prosePrompt: string; patients: SeedJudgePatient[] }
}

// ── Live engine I/O ──────────────────────────────────────────────────────────

/** Load a patient's name + stuff-mode record from the live DB. */
async function loadPatientRecord(
  patientId: string,
): Promise<{ name: string; record: string }> {
  const { name, chunks } = await withClient(async (client) => {
    const pat = await client.query<{ name: string }>('SELECT name FROM patients WHERE id = $1', [
      patientId,
    ])
    if (pat.rows.length === 0) {
      throw new Error(
        `Seed patient "${patientId}" is not in the live DB. Pin a REAL seeded patient id in ${SEED_PATH}.`,
      )
    }
    const ch = await client.query<RecordChunk>(
      'SELECT section, ord, text FROM chunks WHERE patient_id = $1 ORDER BY section, ord',
      [patientId],
    )
    return { name: pat.rows[0].name, chunks: ch.rows }
  })

  const record = assembleStuffRecord(chunks)
  if (!recordFitsBudget(record)) {
    throw new Error(
      `Patient "${patientId}" record (${recordTokenEstimate(record)} tok) overflows the stuff budget. ` +
        `Pick a smaller patient for the worked example.`,
    )
  }
  return { name, record }
}

/** Generate one output against the live engine using the SAME prompt assembly as /api/run. */
async function generate(client: Anthropic, query: string, record: string): Promise<string> {
  const { systemPrompt, userTurnPrompt } = buildPrompt(query, record)
  const response = await client.messages.create({
    model: GENERATION_MODEL,
    max_tokens: GEN_MAX_TOKENS,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userTurnPrompt }],
  })
  const block = response.content.find((c) => c.type === 'text')
  if (!block || block.type !== 'text') throw new Error('No text response from generation model')
  return block.text
}

// ── Leg builders ─────────────────────────────────────────────────────────────

async function buildGoldenLeg(
  client: Anthropic,
  patients: SeedGoldenPatient[],
): Promise<GoldenLegCase[]> {
  const cases: GoldenLegCase[] = []
  for (const p of patients) {
    console.log(`\n── GOLDEN: ${p.patientId} ──`)
    const { name, record } = await loadPatientRecord(p.patientId)
    console.log(`  generating extraction with ${GENERATION_MODEL}`)
    const output = await generate(client, WORKED_PROMPT, record)
    console.log(`  generated ${output.length} chars`)
    cases.push({
      patientId: p.patientId,
      patientName: name,
      output,
      model: GENERATION_MODEL,
      golden: p.golden,
    })
  }
  return cases
}

async function buildJudgeLeg(
  client: Anthropic,
  prosePrompt: string,
  patients: SeedJudgePatient[],
): Promise<JudgeLegCase[]> {
  const cases: JudgeLegCase[] = []
  for (const p of patients) {
    console.log(`\n── JUDGE: ${p.patientId}${p.erroredDemo ? ' (errored demo)' : ''} ──`)
    const { name, record } = await loadPatientRecord(p.patientId)
    console.log(`  generating prose with ${GENERATION_MODEL}`)
    const output = await generate(client, prosePrompt, record)
    console.log(`  generated ${output.length} chars`)

    if (p.erroredDemo) {
      // The designated errored teaching case: RECORD the absence of a verdict. We do
      // NOT call the judge (no metered call) and we do NOT fabricate a ruling — the
      // errored slot carries no pass/reason.
      console.log('  recording ERRORED verdict (no judge call, no fabricated ruling)')
      cases.push({
        patientId: p.patientId,
        patientName: name,
        output,
        model: GENERATION_MODEL,
        verdict: { errored: true },
        judgeModel: null,
      })
      continue
    }

    console.log(`  judging against WORKED_CRITERIA with ${JUDGE_MODEL}`)
    const result = await scoreCriteriaJudge(WORKED_CRITERIA, output, client)
    if (result.errored || result.pass === null || result.reason === null) {
      // A genuine live judge error — record it as errored verbatim (still no
      // fabricated ruling). This naturally satisfies the errored teaching moment too.
      console.log(`  judge errored: ${result.errorMessage ?? 'unknown'}`)
      cases.push({
        patientId: p.patientId,
        patientName: name,
        output,
        model: GENERATION_MODEL,
        verdict: { errored: true },
        judgeModel: null,
      })
    } else {
      console.log(`  verdict pass=${result.pass}`)
      cases.push({
        patientId: p.patientId,
        patientName: name,
        output,
        model: GENERATION_MODEL,
        verdict: { errored: false, pass: result.pass, reason: result.reason },
        judgeModel: JUDGE_MODEL,
      })
    }
  }
  return cases
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var required (this generator hits the live engine)')
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL env var required (patient records come from the live DB)')

  const seed: ExampleSeed = JSON.parse(readFileSync(SEED_PATH, 'utf-8'))
  const client = new Anthropic({ apiKey })

  const goldenCases = await buildGoldenLeg(client, seed.golden.patients)
  const judgeCases = await buildJudgeLeg(client, seed.judge.prosePrompt, seed.judge.patients)

  const artifact: NotebookExampleArtifact = {
    schemaVersion: EXAMPLE_SCHEMA_VERSION,
    description:
      'Worked example (both legs): a diabetes-extraction GOLDEN leg with ≥1 failing row, ' +
      'and a prose-summary JUDGE leg with ≥1 errored verdict. Produced once by a maintainer ' +
      'against the live engine; replays client-side with zero metered calls.',
    generatedAt: new Date().toISOString(),
    models: { generation: GENERATION_MODEL, judge: JUDGE_MODEL },
    golden: { prompt: WORKED_PROMPT, cases: goldenCases },
    judge: { prompt: seed.judge.prosePrompt, criteria: WORKED_CRITERIA, cases: judgeCases },
  }

  // The load-bearing guard. Throws a NAMED error (non-zero exit) if either teaching
  // moment is absent — never silently conforming or fabricating to fill the shape.
  assertTeachingConditions(artifact)

  const failing = failingGoldenCases(artifact.golden)
  const errored = erroredVerdicts(artifact.judge)
  console.log(
    `\nTeaching moments confirmed: ${failing.length} failing golden row(s) ` +
      `[${failing.map((c) => c.patientId).join(', ')}], ` +
      `${errored.length} errored verdict(s) [${errored.map((c) => c.patientId).join(', ')}].`,
  )

  const json = serializeArtifact(artifact)
  mkdirSync(dirname(ARTIFACT_PATH), { recursive: true })
  writeFileSync(ARTIFACT_PATH, json)

  // sha256 sidecar in `sha256sum`-compatible format, hashed over the EXACT bytes
  // written above (so `sha256sum -c example/notebook-example.json.sha256` verifies).
  const hash = createHash('sha256').update(json).digest('hex')
  writeFileSync(SIDECAR_PATH, `${hash}  ${EXAMPLE_ARTIFACT_PATH}\n`)

  console.log(`\nArtifact written to ${EXAMPLE_ARTIFACT_PATH} (sha256 ${hash.slice(0, 12)}…)`)
  console.log(`Sidecar written to ${EXAMPLE_SHA256_PATH}`)
  console.log(
    '\nMANUAL: confirm the two teaching moments above, then commit both files (Desk-verified, like the N1 re-seed).',
  )
}

// Only run when invoked directly (not when imported by a test) — mirrors scripts/seed.ts.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    // Named, human-readable failure + non-zero exit (covers the teaching-condition guard).
    console.error(`\n${err.name ?? 'Error'}: ${err.message}`)
    process.exit(1)
  })
}
