/**
 * compute-kappa.ts
 *
 * Reads evals/golden/human-labels.json and evals/results/seed-baseline.json.
 * Computes:
 *   - inter-human Cohen's kappa (labeler A vs labeler B)
 *   - judge-vs-human-majority Cohen's kappa
 *     majority rule: both labelers must say "supported" → majority=supported, else unsupported
 *     judge verdict: "partial" is treated as "unsupported" for binary kappa
 *   - self-preference indicator: Haiku-judges-Haiku vs Haiku-judges-Sonnet score delta
 *     with output token lengths for verbosity context
 *
 * Writes the kappa values into seed-baseline.json aggregate.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { computeKappa } from '../src/lib/eval/aggregate.js'
import type { BinaryLabel } from '../src/lib/eval/aggregate.js'

const LABELS_PATH = join(process.cwd(), 'evals/golden/human-labels.json')
const BASELINE_PATH = join(process.cwd(), 'evals/results/seed-baseline.json')

// ── Types ────────────────────────────────────────────────────────────────────

interface ClaimLabel {
  claim: string
  labelerA: BinaryLabel
  labelerB: BinaryLabel
  judgeVerdict?: BinaryLabel
}

interface SeedCaseLabel {
  caseId: string
  outputTokens: number
  claims: ClaimLabel[]
}

interface HeldOutCaseLabel {
  caseId: string
  generatorModel: string
  outputTokens: number
  judgeScore: number
  claims: ClaimLabel[]
}

interface HumanLabels {
  seedCases: SeedCaseLabel[]
  heldOutCases: HeldOutCaseLabel[]
}

interface BaselineFaithfulnessClaim {
  claim: string
  verdict: string
}

interface BaselineScorerResult {
  scorer: string
  score: number | null
  zeroClaimFlag?: boolean
  claims?: BaselineFaithfulnessClaim[]
}

interface BaselineCase {
  caseId: string
  scorerResults: BaselineScorerResult[]
  meanScore: number | null
}

interface BaselineAggregate {
  passRate: number | null
  judgeReferenceAgreement: number | null
  n: number
  note: string
  [key: string]: unknown
}

interface Baseline {
  cases: BaselineCase[]
  aggregate: BaselineAggregate
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Map a judge verdict string to a binary label; treat partial as unsupported */
function verdictToBinary(verdict: string): BinaryLabel {
  return verdict === 'supported' ? 'supported' : 'unsupported'
}

/** Compute strict human majority: both must say "supported" → supported, else unsupported */
function humanMajority(a: BinaryLabel, b: BinaryLabel): BinaryLabel {
  return a === 'supported' && b === 'supported' ? 'supported' : 'unsupported'
}

function mean(arr: number[]): number | null {
  if (arr.length === 0) return null
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function round3(x: number | null): number | null {
  return x === null ? null : Math.round(x * 1000) / 1000
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  if (!existsSync(LABELS_PATH)) throw new Error(`human-labels.json not found: ${LABELS_PATH}`)
  if (!existsSync(BASELINE_PATH)) throw new Error(`seed-baseline.json not found: ${BASELINE_PATH}`)

  const labels: HumanLabels = JSON.parse(readFileSync(LABELS_PATH, 'utf-8'))
  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))

  // Build a caseId → faithfulness claims map from the baseline (median run trace)
  const baselineClaimMap = new Map<string, BaselineFaithfulnessClaim[]>()
  for (const bc of baseline.cases) {
    const faithResult = bc.scorerResults.find((r) => r.scorer === 'faithfulness')
    if (faithResult?.claims && !faithResult.zeroClaimFlag) {
      baselineClaimMap.set(bc.caseId, faithResult.claims)
    }
  }

  // Collect all labels across seed + held-out cases
  const aAll: BinaryLabel[] = []
  const bAll: BinaryLabel[] = []
  const judgeAll: BinaryLabel[] = []
  const majorityAll: BinaryLabel[] = []

  // ── Seed cases: judge verdicts from baseline ────────────────────────────────
  for (const sc of labels.seedCases) {
    // Zero-claim or contains-only cases have no faithfulness claims to pair — skip silently
    if (sc.claims.length === 0) continue

    const baselineClaims = baselineClaimMap.get(sc.caseId)
    if (!baselineClaims) {
      console.warn(`  WARN  No baseline faithfulness claims for seed case ${sc.caseId} — skipped`)
      continue
    }

    // Match by claim text, not by array index, to guard against model non-determinism
    const baselineByText = new Map<string, string>()
    for (const bc of baselineClaims) {
      baselineByText.set(bc.claim, bc.verdict)
    }

    let unmatched = 0
    for (const lc of sc.claims) {
      const verdict = baselineByText.get(lc.claim)
      if (verdict === undefined) {
        unmatched++
        continue
      }
      const jv = verdictToBinary(verdict)
      aAll.push(lc.labelerA)
      bAll.push(lc.labelerB)
      judgeAll.push(jv)
      majorityAll.push(humanMajority(lc.labelerA, lc.labelerB))
    }
    if (unmatched > 0) {
      console.warn(
        `  WARN  ${unmatched}/${sc.claims.length} claims unmatched by text in ${sc.caseId} (model non-determinism?) — partial match used`
      )
    }
  }

  // ── Held-out cases: judge verdicts stored in human-labels.json ────────────
  for (const hc of labels.heldOutCases) {
    for (const lc of hc.claims) {
      if (!lc.judgeVerdict) {
        console.warn(`  WARN  Missing judgeVerdict in held-out case ${hc.caseId} — claim skipped`)
        continue
      }
      aAll.push(lc.labelerA)
      bAll.push(lc.labelerB)
      judgeAll.push(lc.judgeVerdict)
      majorityAll.push(humanMajority(lc.labelerA, lc.labelerB))
    }
  }

  const totalN = aAll.length
  console.log(`\nTotal labeled claims: ${totalN}`)

  const interHumanKappa = computeKappa(aAll, bAll)
  const judgeHumanKappa = computeKappa(judgeAll, majorityAll)

  const interHumanAgree = aAll.filter((a, i) => a === bAll[i]).length
  const judgeHumanAgree = judgeAll.filter((j, i) => j === majorityAll[i]).length

  console.log(`Inter-human: agree=${interHumanAgree}/${totalN}, κ=${interHumanKappa?.toFixed(4)}`)
  console.log(`Judge-vs-majority: agree=${judgeHumanAgree}/${totalN}, κ=${judgeHumanKappa?.toFixed(4)}`)

  // ── Self-preference: held-out paired Haiku vs Sonnet outputs ───────────────
  const haikuScores: number[] = []
  const haikuTokens: number[] = []
  const sonnetScores: number[] = []
  const sonnetTokens: number[] = []

  for (const hc of labels.heldOutCases) {
    if (hc.generatorModel.includes('haiku')) {
      haikuScores.push(hc.judgeScore)
      haikuTokens.push(hc.outputTokens)
    } else if (hc.generatorModel.includes('sonnet') || hc.generatorModel.includes('claude-sonnet')) {
      sonnetScores.push(hc.judgeScore)
      sonnetTokens.push(hc.outputTokens)
    }
  }

  const haikuMean = mean(haikuScores)
  const sonnetMean = mean(sonnetScores)
  const delta = haikuMean !== null && sonnetMean !== null ? sonnetMean - haikuMean : null
  const haikuMeanTokens = Math.round((haikuTokens.reduce((a, b) => a + b, 0) / (haikuTokens.length || 1)))
  const sonnetMeanTokens = Math.round((sonnetTokens.reduce((a, b) => a + b, 0) / (sonnetTokens.length || 1)))

  console.log(`Self-preference: haiku_mean=${haikuMean?.toFixed(3)} (${haikuMeanTokens} tok avg), sonnet_mean=${sonnetMean?.toFixed(3)} (${sonnetMeanTokens} tok avg), delta=${delta?.toFixed(3)}`)
  if (delta !== null && delta < 0) {
    console.log(`  → Judge scores Haiku outputs higher by ${Math.abs(delta).toFixed(3)}; Sonnet outputs are ~${Math.round(sonnetMeanTokens / haikuMeanTokens)}x longer (verbosity confound plausible)`)
  }

  // ── Write augmented aggregate back to baseline ────────────────────────────
  const augmented = {
    ...baseline.aggregate,
    judgeHumanKappa: round3(judgeHumanKappa),
    interHumanKappa: round3(interHumanKappa),
    kappaN: totalN,
    kappaNotes:
      'directional, small-n; labels from AI-proxy labelers (haiku strict, sonnet lenient) as documented in evals/golden/human-labels.json; strict majority rule (both labelers must agree supported)',
    selfPreference: {
      haikuJudgesHaikuMeanScore: round3(haikuMean),
      haikuJudgesSonnetMeanScore: round3(sonnetMean),
      delta: round3(delta),
      haikuMeanOutputTokens: haikuMeanTokens,
      sonnetMeanOutputTokens: sonnetMeanTokens,
      n: Math.min(haikuScores.length, sonnetScores.length),
      note: 'negative delta means Haiku-generated outputs score higher; verbosity confound: Sonnet outputs are longer on average',
    },
  }

  baseline.aggregate = augmented
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2))
  console.log(`\nBaseline aggregate updated: ${BASELINE_PATH}`)
  console.log(`  judgeHumanKappa=${augmented.judgeHumanKappa}  interHumanKappa=${augmented.interHumanKappa}  kappaN=${augmented.kappaN}`)
}

main()
