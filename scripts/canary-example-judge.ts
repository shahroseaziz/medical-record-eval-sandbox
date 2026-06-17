/**
 * scripts/canary-example-judge.ts — worked-example JUDGE-LEG drift canary (N13b).
 *
 * The highest-visibility correctness surface in the product is the worked example:
 * it is the canonical "this is what an eval looks like" walkthrough every first-time
 * user replays. This nightly canary re-runs the example's JUDGE leg against the LIVE
 * engine and compares each fresh verdict to the verdict COMMITTED in the artifact —
 * so a judge-quality drift (a model or template change that silently flips a worked
 * verdict) is caught by default, not only when a user notices.
 *
 * It runs the SINGLE-CALL criteria-verdict path (`scoreCriteriaJudge`) against the
 * artifact's PINNED criteria — the same path the loader replays. Errored committed
 * verdicts are SKIPPED (there is no recorded ruling to compare against — the errored
 * verdict is itself a teaching moment, not a score). Before any live call it asserts
 * judge-prompt parity (incl. the criteria template + the pinned criteria text), since
 * a drifted template would re-roll every verdict and make the comparison meaningless.
 *
 * PENDING (exit 0, not a failure): the artifact is a maintainer-committed fixture and
 * may not have landed yet (example/README.md). Absent → skip cleanly.
 *
 * Exit codes:  0 green OR pending   ·   1 drift (a fresh verdict ≠ the committed one)
 *              ·   2 inconclusive (Claude down / no key)
 *
 * Usage:  ANTHROPIC_API_KEY=… npx tsx scripts/canary-example-judge.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scoreCriteriaJudge } from '../src/lib/eval/scorers/criteria-judge.js'
import { isUpstreamOutage } from '../evals/run_evals.js'
import { checkJudgePromptParity } from '../evals/harness/prompt-hash.js'
import {
  parseExampleArtifact,
  EXAMPLE_ARTIFACT_PATH,
} from '../src/app/notebook/example-artifact.js'

const EXIT_GREEN = 0
const EXIT_DRIFT = 1
const EXIT_INCONCLUSIVE = 2

const ARTIFACT_PATH = join(process.cwd(), EXAMPLE_ARTIFACT_PATH)

function log(msg: string): void {
  process.stdout.write(msg + '\n')
}

async function main(): Promise<void> {
  log('worked-example judge-leg drift canary — scripts/canary-example-judge.ts')

  // PENDING: the maintainer has not landed the artifact yet.
  if (!existsSync(ARTIFACT_PATH)) {
    log(`  ~  pending: ${EXAMPLE_ARTIFACT_PATH} not committed yet — nothing to re-grade.`)
    process.exit(EXIT_GREEN)
  }

  // Parity FIRST — a drifted template/criteria invalidates the comparison.
  const drift = checkJudgePromptParity()
  if (drift.length > 0) {
    for (const d of drift) log(`  ✗  ${d}`)
    log('  ✗  judge-prompt parity broke — re-baseline deliberately before trusting the canary.')
    process.exit(EXIT_DRIFT)
  }
  log('  OK  judge prompt + criteria hashes match committed baseline')

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    log('  ~  inconclusive: ANTHROPIC_API_KEY not set — cannot re-grade the live judge leg.')
    process.exit(EXIT_INCONCLUSIVE)
  }

  const artifact = parseExampleArtifact(JSON.parse(readFileSync(ARTIFACT_PATH, 'utf-8')))
  const client = new Anthropic({ apiKey })
  const { criteria, cases } = artifact.judge

  let compared = 0
  let skipped = 0
  const mismatches: string[] = []

  for (const c of cases) {
    if (c.verdict.errored) {
      // No recorded ruling to compare against — the errored verdict is a teaching
      // moment, not a score. Skip (never fabricate an expectation).
      skipped++
      log(`  ~  ${c.patientId}: committed verdict errored — skipped (no ruling to compare)`)
      continue
    }

    let result
    try {
      result = await scoreCriteriaJudge(criteria, c.output, client)
    } catch (err) {
      if (isUpstreamOutage(err)) {
        log('  ~  inconclusive: Claude appears to be down mid-run.')
        process.exit(EXIT_INCONCLUSIVE)
      }
      throw err
    }

    if (result.errored || result.pass === null) {
      // A transient live judge error on a case we expected to settle: inconclusive,
      // not a drift verdict (we never turn a flaky call into a red).
      log(`  ~  inconclusive: live judge errored on ${c.patientId} — ${result.errorMessage ?? 'unknown'}`)
      process.exit(EXIT_INCONCLUSIVE)
    }

    compared++
    if (result.pass === c.verdict.pass) {
      log(`  OK  ${c.patientId}: live verdict pass=${result.pass} matches committed`)
    } else {
      mismatches.push(
        `${c.patientId}: live pass=${result.pass} ≠ committed pass=${c.verdict.pass}`,
      )
      log(`  ✗  ${c.patientId}: live verdict pass=${result.pass} ≠ committed pass=${c.verdict.pass}`)
    }
  }

  log(`\n  compared ${compared} verdict(s), skipped ${skipped} errored.`)

  if (mismatches.length > 0) {
    log(`  ✗  DRIFT: ${mismatches.length} worked-example verdict(s) changed vs the committed artifact:`)
    for (const m of mismatches) log(`       ${m}`)
    log('     The highest-visibility teaching fixture no longer reproduces. Investigate the')
    log('     judge model/template change, then regenerate the artifact via the maintainer flow.')
    process.exit(EXIT_DRIFT)
  }

  log('  ✓  green: every committed worked-example judge verdict still reproduces live.')
  process.exit(EXIT_GREEN)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: Error) => {
    console.error(`\n${err.name ?? 'Error'}: ${err.message}`)
    process.exit(EXIT_DRIFT)
  })
}
