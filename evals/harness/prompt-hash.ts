/**
 * Judge-prompt template hashes (O11 / E28f — specialist amendment 2026-06-10).
 *
 * The committed prompt templates ARE the judge: a silent edit to any builder
 * re-rolls every score while `judgeModel` still matches, so the static baseline
 * would lie exactly the way a model swap would. This pins the rendered template
 * text into the CI parity equality class alongside EXPECTED_JUDGE_MODEL /
 * EXPECTED_EMBEDDING_MODEL.
 *
 * Mechanism: each builder is rendered with FIXED sentinel inputs and sha256'd.
 * Any change to the template wording, ordering, or structure changes the hash;
 * sentinel inputs never change, so the hash is deterministic. To change a judge
 * prompt DELIBERATELY: update the template, run
 * `npx tsx evals/harness/prompt-hash.ts` and commit the printed hashes here —
 * a visible, reviewable re-baseline (never silent).
 */

import { createHash } from 'node:crypto'
import { buildExtractPrompt, buildVerdictPrompt } from '../../src/lib/eval/scorers/faithfulness.js'
import { buildReferencePrompt } from '../../src/lib/eval/scorers/reference-judge.js'

const SENTINEL = {
  output: '__PROMPT_HASH_SENTINEL_OUTPUT__',
  claims: ['__SENTINEL_CLAIM_1__', '__SENTINEL_CLAIM_2__'],
  grounding: '__PROMPT_HASH_SENTINEL_GROUNDING__',
  expected: '__PROMPT_HASH_SENTINEL_EXPECTED__',
} as const

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Render each judge prompt template against the sentinels and hash it. */
export function computeJudgePromptHashes(): Record<string, string> {
  return {
    extract: sha256(buildExtractPrompt(SENTINEL.output)),
    // Default rubric path — the committed verdict template (user rubrics are
    // uncalibrated by construction, E21; the pin guards the DEFAULT the
    // baseline + example gate score with).
    verdict: sha256(buildVerdictPrompt([...SENTINEL.claims], SENTINEL.grounding)),
    reference: sha256(buildReferencePrompt(SENTINEL.output, SENTINEL.expected)),
  }
}

/** The committed baseline. Re-baseline deliberately via `npx tsx evals/harness/prompt-hash.ts`. */
export const EXPECTED_JUDGE_PROMPT_HASHES: Record<string, string> = {
  extract: '888649381c5d011392119b59fa8b3025778f7785ded7abee82e2966a8de80573',
  verdict: '4b0f2dc2ed4b4a0eb344d5055be9b5d7c371e06351d9b84a9db676547f132060',
  reference: '046c3297de9aad1a23d0c7b40b9553320c1a2ab1537e0139b828fda761c51310',
}

/** Returns a violation string per drifted template; empty = parity holds. */
export function checkJudgePromptParity(): string[] {
  const actual = computeJudgePromptHashes()
  const violations: string[] = []
  for (const [name, expected] of Object.entries(EXPECTED_JUDGE_PROMPT_HASHES)) {
    if (actual[name] !== expected) {
      violations.push(
        `judge prompt template "${name}" drifted: expected ${expected.slice(0, 12)}…, got ${actual[name].slice(0, 12)}… — ` +
          `a template edit re-rolls every score; re-baseline deliberately in evals/harness/prompt-hash.ts`,
      )
    }
  }
  return violations
}

// CLI: print current hashes for deliberate re-baselining.
if (process.argv[1] && process.argv[1].endsWith('prompt-hash.ts')) {
  console.log(JSON.stringify(computeJudgePromptHashes(), null, 2))
}
