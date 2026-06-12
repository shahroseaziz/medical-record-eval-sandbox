/**
 * Partial-vs-binary verdict elicitation comparison (O11 / D1 — the gate-worthy
 * specialist item, resolved as a ONE-TIME committed artifact, never a blocker).
 *
 * The shipped 3-option verdict scale (supported/unsupported/partial) may park
 * borderline "supported" claims in partial→0, depressing scores vs RAGAS's
 * binary NLI and shifting what the 0.85 threshold means. This scores the seed
 * set BOTH ways and commits the divergence. Per D1: if mean |Δ| > 0.05, file a
 * follow-up to revisit elicitation — do not block the cycle.
 *
 * Maintainer-run (live tokens): ANTHROPIC_API_KEY=… npx tsx evals/harness/partial-vs-binary.ts
 * Requires the seed cases' grounding — uses each case's committed grounding from
 * the baseline trace (seed-baseline.json), the same context the judge scored.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreFaithfulness } from '../../src/lib/eval/scorers/faithfulness.js'
import type { EvalCase } from '../../src/lib/eval/types.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const BASELINE = JSON.parse(readFileSync(join(HERE, '..', 'results', 'seed-baseline.json'), 'utf8'))
const SEEDS = JSON.parse(readFileSync(join(HERE, '..', 'golden', 'seed-cases.json'), 'utf8'))
const OUT = join(HERE, '..', 'results', 'partial-vs-binary.json')

const BINARY_RUBRIC = `- "supported": the claim is stated in or directly entailed by the grounding context.
- "unsupported": everything else — if you cannot point to grounding that entails the claim, it is unsupported. There is NO middle option: do not use "partial".`

const D1_TOLERANCE = 0.05

async function main() {
  const rows: Array<Record<string, unknown>> = []
  for (const c of BASELINE.cases) {
    const sc = SEEDS.find((s: { id: string }) => s.id === c.caseId)
    if (!sc || !sc.scorers?.includes?.('faithfulness')) continue
    if (sc.ragMode !== 'retrieve') continue // grounding reconstructable from the trace only
    // Same trace→case reconstruction run_evals.ts uses for baseline reproduction.
    const evalCase: EvalCase = {
      id: c.caseId,
      patientId: sc.patientId,
      query: sc.taskPrompt,
      output: c.trace.output,
      expectedOutput: sc.expectedOutput,
      k: BASELINE.k,
      mode: 'retrieve',
      retrievedChunks: c.trace.retrievedChunks ?? [],
    }
    // Default (3-option) elicitation = no rubric override; binary = override.
    const def = await scoreFaithfulness(evalCase)
    const bin = await scoreFaithfulness(evalCase, undefined, BINARY_RUBRIC)
    if (def.errored || bin.errored || def.score == null || bin.score == null) {
      throw new Error(`case ${c.caseId} errored (default=${def.errorMessage} binary=${bin.errorMessage})`)
    }
    rows.push({ id: c.caseId, threeOption: def.score, binary: bin.score, absDelta: Math.abs(def.score - bin.score) })
    console.log(`${c.caseId}: 3opt=${def.score.toFixed(3)} binary=${bin.score.toFixed(3)}`)
  }
  const meanAbsDelta = rows.reduce((a, r) => a + (r.absDelta as number), 0) / rows.length
  const artifact = {
    generated: new Date().toISOString().slice(0, 10),
    method: 'seed cases scored by the shipped 3-option judge AND a binary-elicitation judge, same fixtures (D1)',
    tolerance: D1_TOLERANCE,
    meanAbsDelta,
    withinTolerance: meanAbsDelta <= D1_TOLERANCE,
    followUp: meanAbsDelta <= D1_TOLERANCE ? null : 'mean |Δ| exceeds D1 tolerance — file a Linear follow-up to revisit verdict elicitation',
    cases: rows,
  }
  writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n')
  console.log(`wrote ${OUT}: meanAbsDelta=${meanAbsDelta.toFixed(4)} withinTolerance=${artifact.withinTolerance}`)
}
main()
