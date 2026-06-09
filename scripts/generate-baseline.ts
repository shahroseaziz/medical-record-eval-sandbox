/**
 * generate-baseline.ts
 *
 * For each case in evals/golden/seed-cases.json:
 *   1. Build grounding context (retrieve k=5 chunks via pgvector, or stuff the full
 *      parsed record from the fixture file).
 *   2. Generate a model output ONCE with claude-haiku-4-5 (or use preauthoredOutput
 *      when present — used for designed-fail cases).
 *   3. Run the two-call faithfulness judge k=5 times; record the median run's trace.
 *   4. Run contains / section-hit scorers once each.
 *
 * Emits:
 *   evals/results/seed-baseline.json  — per-case results + aggregate stats
 *   evals/results/overflow-demo.json  — static explainer for Agustin437 overflow
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { parseCcda } from '../src/lib/ccda/index.js'
import { retrieve } from '../src/lib/rag/index.js'
import { scoreFaithfulness } from '../src/lib/eval/scorers/faithfulness.js'
import { scoreContains } from '../src/lib/eval/scorers/contains.js'
import { scoreSectionHit } from '../src/lib/eval/scorers/section-hit.js'
import { scoreStructuredDiff } from '../src/lib/eval/scorers/structured-diff.js'
import { scoreReferenceJudge } from '../src/lib/eval/scorers/reference-judge.js'
import {
  computeMeanScore,
  computeStdDev,
  medianRunIndex,
  computeAggregate,
} from '../src/lib/eval/aggregate.js'
import type { EvalCase, FaithfulnessResult } from '../src/lib/eval/index.js'

// ── Constants ────────────────────────────────────────────────────────────────

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const EMBEDDING_MODEL = 'voyage-3.5'
const K = 6

const GOLDEN_PATH = join(process.cwd(), 'evals/golden/seed-cases.json')
const BASELINE_PATH = join(process.cwd(), 'evals/results/seed-baseline.json')
const OVERFLOW_PATH = join(process.cwd(), 'evals/results/overflow-demo.json')
const FIXTURE_DIR = join(process.cwd(), 'src/lib/ccda/__fixtures__')

// ── Types ────────────────────────────────────────────────────────────────────

interface SeedCase {
  id: string
  taskPrompt: string
  patientId: string
  ragMode: 'retrieve' | 'stuff'
  expectedOutput: string
  referenceLabel: 'pass' | 'fail'
  requiredSections?: string[]
  expectedClaims?: string[]
  preauthoredOutput?: string
  /** Hand-authored expected structured output (field→value), graded by structured-diff. */
  expectedStructured?: Record<string, unknown>
  /** Hand-authored expected prose reference, graded by reference-judge. */
  expectedProse?: string
  /** Maps each expected-output field to the scorer that grades it. */
  fieldScorers?: Record<string, string>
  rationale: string
  scorers: string[]
}

interface CaseTrace {
  output: string
  retrievedChunks?: Array<{ section: string; text: string }>
  extractPrompt?: string
  verdictPrompt?: string
}

interface CaseResult {
  caseId: string
  trace: CaseTrace
  scorerResults: Array<Record<string, unknown>>
  meanScore: number | null
  scoreStdDev: number | null
  referenceLabel: 'pass' | 'fail'
}

// ── Fixture loader ───────────────────────────────────────────────────────────

const _fixtureCache = new Map<string, string>()

function getPatientRecordText(patientId: string): string {
  if (_fixtureCache.has(patientId)) return _fixtureCache.get(patientId)!

  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.xml'))
  for (const file of files) {
    const xml = readFileSync(join(FIXTURE_DIR, file), 'utf-8')
    const result = parseCcda(xml)
    if (result.patientId === patientId) {
      const text = result.sections
        .map((s) => `[${s.section.toUpperCase()}]\n${s.text}`)
        .join('\n\n---\n\n')
      _fixtureCache.set(patientId, text)
      return text
    }
  }
  throw new Error(`Patient ${patientId} not found in fixture dir ${FIXTURE_DIR}`)
}

// ── Model output generation ──────────────────────────────────────────────────

async function generateOutput(client: Anthropic, taskPrompt: string, context: string): Promise<string> {
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 1024,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: `${taskPrompt}\n\nCONTEXT:\n${context}`,
      },
    ],
  })
  const block = response.content.find((c) => c.type === 'text')
  if (!block || block.type !== 'text') throw new Error('No text response from model')
  return block.text
}

// ── Faithfulness scoring (k runs) ────────────────────────────────────────────

async function runFaithfulnessK(
  evalCase: EvalCase,
  client: Anthropic,
  k: number
): Promise<{
  results: FaithfulnessResult[]
  meanScore: number | null
  scoreStdDev: number
  medianIdx: number
}> {
  const results: FaithfulnessResult[] = []
  for (let i = 0; i < k; i++) {
    results.push(await scoreFaithfulness(evalCase, client))
  }
  const meanScore = computeMeanScore(results)
  const scoreStdDev = computeStdDev(results)
  const medianIdx = medianRunIndex(results)
  return { results, meanScore, scoreStdDev, medianIdx }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var required')

  const seedCases: SeedCase[] = JSON.parse(readFileSync(GOLDEN_PATH, 'utf-8'))
  const client = new Anthropic({ apiKey })

  const caseResults: CaseResult[] = []
  const faithAggInputs: Array<{ meanScore: number | null; referenceLabel: 'pass' | 'fail'; zeroClaimFlag: boolean }> = []

  for (const sc of seedCases) {
    console.log(`\n── Case: ${sc.id} ──`)

    // Build grounding context
    let context: string
    let retrievedChunks: Array<{ section: string; text: string }> | undefined

    if (sc.ragMode === 'retrieve') {
      console.log(`  retrieve k=${K} for patient ${sc.patientId}`)
      const rr = await retrieve(sc.patientId, sc.taskPrompt, K)
      retrievedChunks = rr.chunks.map((c) => ({ section: c.section, text: c.text }))
      context = retrievedChunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
      console.log(`  retrieved ${retrievedChunks.length} chunks: ${retrievedChunks.map((c) => c.section).join(', ')}`)
    } else {
      console.log(`  stuffing full record for patient ${sc.patientId}`)
      context = getPatientRecordText(sc.patientId)
    }

    // Generate or use pre-authored output
    let output: string
    if (sc.preauthoredOutput) {
      output = sc.preauthoredOutput
      console.log(`  using pre-authored output (${output.length} chars)`)
    } else {
      console.log(`  generating output with ${HAIKU_MODEL}`)
      output = await generateOutput(client, sc.taskPrompt, context)
      console.log(`  generated ${output.length} chars`)
    }

    // Build EvalCase for scorers
    const evalCase: EvalCase = {
      id: sc.id,
      patientId: sc.patientId,
      query: sc.taskPrompt,
      output,
      mode: sc.ragMode,
      retrievedChunks: sc.ragMode === 'retrieve' ? retrievedChunks : undefined,
      record: sc.ragMode === 'stuff' ? context : undefined,
      expectedOutput: sc.expectedOutput,
      expectedClaims: sc.expectedClaims,
      requiredSections: sc.requiredSections,
      expectedStructured: sc.expectedStructured,
      expectedProse: sc.expectedProse,
      fieldScorers: sc.fieldScorers as EvalCase['fieldScorers'],
      k: K,
    }

    // Run scorers
    const scorerResults: Array<Record<string, unknown>> = []
    let meanScore: number | null = null
    let scoreStdDev: number | null = null
    let trace: CaseTrace = { output, retrievedChunks }

    for (const scorer of sc.scorers) {
      if (scorer === 'faithfulness') {
        console.log(`  running faithfulness judge ×${K}`)
        const { results, meanScore: ms, scoreStdDev: sd, medianIdx } = await runFaithfulnessK(evalCase, client, K)
        meanScore = ms
        scoreStdDev = sd

        const medianRun = results[medianIdx]
        trace = {
          output,
          retrievedChunks,
          extractPrompt: medianRun.extractPrompt,
          verdictPrompt: medianRun.verdictPrompt,
        }

        const zeroClaimFlag = results.every((r) => r.zeroClaimFlag)
        faithAggInputs.push({ meanScore: ms, referenceLabel: sc.referenceLabel, zeroClaimFlag })

        scorerResults.push({
          scorer: 'faithfulness',
          score: meanScore,
          zeroClaimFlag,
          claims: medianRun.claims,
          extractPrompt: medianRun.extractPrompt,
          verdictPrompt: medianRun.verdictPrompt,
          allRunScores: results.map((r) => ({ score: r.score, claimCount: r.claims.length, zeroClaimFlag: r.zeroClaimFlag })),
        })
        console.log(`  faithfulness meanScore=${meanScore?.toFixed(3)} stdDev=${sd.toFixed(3)} zeroClaimFlag=${zeroClaimFlag}`)
      } else if (scorer === 'contains') {
        const r = scoreContains(evalCase)
        scorerResults.push(r as unknown as Record<string, unknown>)
        console.log(`  contains score=${r.score}`)
      } else if (scorer === 'section-hit') {
        const r = scoreSectionHit(evalCase)
        scorerResults.push(r as unknown as Record<string, unknown>)
        console.log(`  section-hit score=${r.score} retrieved=[${r.retrievedSections.join(',')}]`)
      } else if (scorer === 'structured-diff') {
        // Deterministic, client-side (free) per-field diff of expectedStructured vs
        // the committed output. Produces identical results on every run — this is
        // what makes the guided lesson's Beat-1 diff stable instead of flaky.
        const r = scoreStructuredDiff(evalCase)
        scorerResults.push(r as unknown as Record<string, unknown>)
        console.log(`  structured-diff score=${r.score?.toFixed(4) ?? 'null'} match=${r.matchCount} mismatch=${r.mismatchCount} missing=${r.missingCount} extra=${r.extraCount}`)
      } else if (scorer === 'reference-judge') {
        // LLM meaning-equivalence judge of the committed output vs expectedProse.
        // Run once at baseline-generation time; the committed verdict is what the
        // lesson's Beat-2 reads — the lesson never re-calls the judge live.
        if (!sc.expectedProse) {
          console.log('  reference-judge skipped — case has no expectedProse')
        } else {
          const r = await scoreReferenceJudge(output, sc.expectedProse, client)
          scorerResults.push(r as unknown as Record<string, unknown>)
          console.log(`  reference-judge verdict=${r.verdict ?? 'errored'} score=${r.score ?? 'null'}`)
        }
      }
    }

    caseResults.push({
      caseId: sc.id,
      trace,
      scorerResults,
      meanScore,
      scoreStdDev,
      referenceLabel: sc.referenceLabel,
    })
  }

  // Aggregate over faithfulness cases only (exclude zero-claim runs)
  const aggregate = computeAggregate(faithAggInputs)

  const baseline = {
    judgeModel: HAIKU_MODEL,
    embeddingModel: EMBEDDING_MODEL,
    k: K,
    generatedAt: new Date().toISOString(),
    cases: caseResults,
    aggregate,
  }

  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))
  console.log(`\nBaseline written to ${BASELINE_PATH}`)
  console.log(`Aggregate: passRate=${aggregate.passRate?.toFixed(3)} judgeReferenceAgreement=${aggregate.judgeReferenceAgreement?.toFixed(3)} n=${aggregate.n}`)

  // Static overflow demo
  writeFileSync(
    OVERFLOW_PATH,
    JSON.stringify(
      {
        description:
          'Demonstration of context overflow when stuffing the 6 MB Agustin437 C-CDA record vs. using retrieve mode.',
        patientId: 'e0de7b0a-c40b-6467-c099-0f9467be6c0a',
        patientFile:
          'Agustin437_Hills818_e0de7b0a-c40b-6467-c099-0f9467be6c0a.xml',
        rawFileSizeBytes: 6391614,
        rawFileSizeHuman: '~6.1 MB',
        tiers: [
          {
            tier: 'retrieve',
            ragMode: 'retrieve',
            k: K,
            description:
              `Vector retrieval returns the k=${K} most semantically relevant chunks. ` +
              'Each chunk is ≤ ~1500 tokens. Total context: 1 500–4 500 tokens. ' +
              'Fits comfortably within any current Claude model context window.',
            estimatedContextTokens: '1 500 – 4 500',
            overflowRisk: 'none',
          },
          {
            tier: 'stuff',
            ragMode: 'stuff',
            k: 'all',
            description:
              'Stuffing the full parsed narrative text of the 6 MB Agustin437 record ' +
              'into the model context results in severe overflow. After HTML stripping ' +
              'the 131 K-line XML file yields ~400 000+ characters of plain text ' +
              '(~100 000+ tokens) — exceeding all current Claude model context windows ' +
              'and guaranteed to cause truncation or API errors.',
            estimatedContextChars: '400 000+',
            estimatedContextTokens: '100 000+',
            overflowRisk:
              'extreme — exceeds all current model context windows; causes truncation or API rejection',
          },
        ],
        conclusion:
          'Retrieve mode (pgvector HNSW) is mandatory for large C-CDA records such as ' +
          'Agustin437. Stuff mode is only viable for records whose parsed narrative fits ' +
          'within the model context window (typically < 100 KB raw XML / < 10 000 tokens).',
      },
      null,
      2
    )
  )
  console.log(`Overflow demo written to ${OVERFLOW_PATH}`)
}

main().catch((err: Error) => {
  console.error(err)
  process.exit(1)
})
