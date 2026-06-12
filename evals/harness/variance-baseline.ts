/**
 * Reference-judge variance baseline (O11 / eval-engineer synthesis).
 *
 * A new LLM judge never inherits an unproduced tolerance: k runs of the
 * reference judge over the committed fixture pair produce a mean/σ that the
 * gate's band reasoning can cite. Maintainer-run (live tokens):
 *   ANTHROPIC_API_KEY=… npx tsx evals/harness/variance-baseline.ts
 * Output committed at evals/results/reference-judge-variance.json.
 * Honesty note (carried from the specialist panel): σ̂ from k=5 is itself
 * high-variance — the floor does the real work; this is a looser-of-two guard,
 * not a true 3-sigma interval.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scoreReferenceJudge } from '../../src/lib/eval/scorers/reference-judge.js'
import { REFERENCE_JUDGE_FIXTURE } from '../run_evals_example.js'

const K = 5
const OUT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'results', 'reference-judge-variance.json')

async function main() {
  const scores: number[] = []
  for (let i = 0; i < K; i++) {
    const r = await scoreReferenceJudge(REFERENCE_JUDGE_FIXTURE.actual, REFERENCE_JUDGE_FIXTURE.expected)
    if (r.errored || r.score == null) throw new Error(`run ${i + 1} errored: ${r.errorMessage}`)
    scores.push(r.score)
    console.log(`run ${i + 1}/${K}: ${r.score}`)
  }
  const mean = scores.reduce((a, b) => a + b, 0) / K
  const sigma = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / K)
  const artifact = {
    generated: new Date().toISOString().slice(0, 10),
    fixture: 'REFERENCE_JUDGE_FIXTURE (run_evals_example.ts)',
    k: K,
    scores,
    meanScore: mean,
    sigma,
    band_note:
      'band = mean ± max(0.05, 3σ); at k=5 the 0.05 floor does the real work — looser-of-two guard, not a true 3-sigma interval',
  }
  writeFileSync(OUT, JSON.stringify(artifact, null, 2) + '\n')
  console.log(`wrote ${OUT}: mean=${mean.toFixed(3)} σ=${sigma.toFixed(3)}`)
}
main()
