/**
 * scripts/observability/quality-report.ts — Quality report over production traces
 *
 * Queries the Neon `traces` table (REQUIRED — exits 1 if DB is unreachable or the
 * table is missing) and computes quality metrics over a rolling window of runs:
 *
 *   zero-claim rate        % of faithfulness runs where the judge extracted 0 claims
 *   sectionHit miss rate   % of retrieve-mode runs where required sections weren't hit
 *   judge-error rate       % of faithfulness runs that returned an errored result
 *   faithfulness p50/p90   score percentiles (non-null, non-zero-claim runs only)
 *   model drift            any traces using unexpected judgeModel or embeddingModel
 *                          (MODEL-DEPRECATION failure mode — silent model substitution)
 *
 * Per-metric alert thresholds live here, not hardcoded inline, so they can be
 * adjusted without hunting for magic numbers.
 *
 * Env:
 *   DATABASE_URL   Neon connection string (required)
 *   WINDOW_DAYS    Lookback window in days (default: 30)
 *
 * Exit codes:
 *   0  report generated, no thresholds breached
 *   1  one or more metrics exceeded alert threshold (or DB unavailable)
 */

import { Client } from 'pg'

// ── Alert thresholds ──────────────────────────────────────────────────────────
// Adjust these values as production volume grows; current values are conservative
// floors appropriate for a low-traffic sandbox with a small golden set.

const THRESHOLDS = {
  /** Alert when > 10 % of faithfulness runs produce 0 claims */
  zeroClaimRateMax: 0.10,
  /** Alert when > 20 % of retrieve-mode runs miss a required section */
  sectionMissRateMax: 0.20,
  /** Alert when > 5 % of faithfulness runs error */
  judgeErrorRateMax: 0.05,
  /** Alert when faithfulness p50 drops below 0.70 */
  faithfulnessP50Min: 0.70,
  /** Alert when faithfulness p90 drops below 0.85 (the gate threshold) */
  faithfulnessP90Min: 0.85,
  /** Minimum trace count before rate metrics are reported (avoid noise at low n) */
  minTracesForRates: 5,
}

// MODEL-DEPRECATION: pinned model names. Any trace carrying a different model name
// indicates a silent substitution (Anthropic/Voyage deprecated the model and the
// caller's code is fetching the old name) — which changes scoring behaviour without
// any code change.
const EXPECTED_JUDGE_MODEL = 'claude-haiku-4-5-20251001'
const EXPECTED_EMBEDDING_MODEL = 'voyage-3.5'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FaithfulnessClaim {
  verdict: 'supported' | 'unsupported' | 'partial'
}

interface FaithfulnessResult {
  scorer: 'faithfulness'
  score: number | null
  zeroClaimFlag?: boolean
  errored?: boolean
  errorMessage?: string
  claims: FaithfulnessClaim[]
}

interface SectionHitResult {
  scorer: 'section-hit'
  score: 0 | 1 | null
  missingSections: string[]
}

type ScorerResult = FaithfulnessResult | SectionHitResult | { scorer: string }

interface TraceRecord {
  caseId: string
  ragMode: 'retrieve' | 'stuff'
  judgeModel: string
  embeddingModel: string
  scorerResults: ScorerResult[]
  tokens: { input: number; output: number; estCostUsd: number }
  claimCount: number
  outputLength: number
}

interface QualityAlert {
  metric: string
  value: string
  threshold: string
  message: string
}

interface QualityReport {
  windowDays: number
  totalTraces: number
  faithfulnessTraces: number
  retrieveTraces: number
  zeroClaimRate: number | null
  sectionMissRate: number | null
  judgeErrorRate: number | null
  faithfulnessP50: number | null
  faithfulnessP90: number | null
  unexpectedJudgeModels: string[]
  unexpectedEmbeddingModels: string[]
  alerts: QualityAlert[]
  generatedAt: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  const idx = Math.max(0, Math.ceil(p * sorted.length) - 1)
  return sorted[idx]
}

function fmt(n: number | null, decimals = 4): string {
  return n == null ? 'N/A' : n.toFixed(decimals)
}

function pct(n: number | null): string {
  return n == null ? 'N/A' : `${(n * 100).toFixed(1)}%`
}

// ── Main computation ──────────────────────────────────────────────────────────

async function computeQualityReport(client: Client, windowDays: number): Promise<QualityReport> {
  const alerts: QualityAlert[] = []

  // Require the traces table to exist and be queryable.
  // HARD FAIL — this is not a soft fallback. If Neon is suspended or the table is
  // missing, production monitoring is broken and should alert, not silently pass.
  const rows = await client.query<{ trace: TraceRecord }>(
    `SELECT trace
     FROM traces
     WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
     ORDER BY created_at DESC`,
    [String(windowDays)]
  )

  const traces = rows.rows.map((r) => r.trace)
  const totalTraces = traces.length

  // Separate faithfulness and retrieve-mode traces
  const faithfulnessTraces: { score: number | null; zeroClaim: boolean; errored: boolean }[] = []
  let retrieveTotal = 0
  let sectionMissCount = 0
  const unexpectedJudgeModels = new Set<string>()
  const unexpectedEmbeddingModels = new Set<string>()

  for (const t of traces) {
    // MODEL-DEPRECATION check
    if (t.judgeModel && t.judgeModel !== EXPECTED_JUDGE_MODEL) {
      unexpectedJudgeModels.add(t.judgeModel)
    }
    if (
      t.embeddingModel &&
      t.embeddingModel !== EXPECTED_EMBEDDING_MODEL &&
      t.embeddingModel !== 'none'
    ) {
      unexpectedEmbeddingModels.add(t.embeddingModel)
    }

    for (const sr of t.scorerResults ?? []) {
      if (sr.scorer === 'faithfulness') {
        const fr = sr as FaithfulnessResult
        faithfulnessTraces.push({
          score: fr.score ?? null,
          zeroClaim: fr.zeroClaimFlag ?? false,
          errored: fr.errored ?? false,
        })
      }
      if (sr.scorer === 'section-hit' && t.ragMode === 'retrieve') {
        retrieveTotal++
        const sh = sr as SectionHitResult
        if (sh.score !== 1) sectionMissCount++
      }
    }
  }

  const faithfulnessTotal = faithfulnessTraces.length

  // ── Zero-claim rate ───────────────────────────────────────────────────────
  const zeroClaimCount = faithfulnessTraces.filter((t) => t.zeroClaim && !t.errored).length
  const zeroClaimRate = faithfulnessTotal > 0 ? zeroClaimCount / faithfulnessTotal : null

  if (
    faithfulnessTotal >= THRESHOLDS.minTracesForRates &&
    zeroClaimRate !== null &&
    zeroClaimRate > THRESHOLDS.zeroClaimRateMax
  ) {
    alerts.push({
      metric: 'zero-claim-rate',
      value: pct(zeroClaimRate),
      threshold: pct(THRESHOLDS.zeroClaimRateMax),
      message:
        `Zero-claim rate ${pct(zeroClaimRate)} > threshold ${pct(THRESHOLDS.zeroClaimRateMax)} ` +
        '— judge may be failing to extract claims; check extraction prompt',
    })
  }

  // ── sectionHit miss rate ──────────────────────────────────────────────────
  const sectionMissRate =
    retrieveTotal >= THRESHOLDS.minTracesForRates ? sectionMissCount / retrieveTotal : null

  if (
    sectionMissRate !== null &&
    sectionMissRate > THRESHOLDS.sectionMissRateMax
  ) {
    alerts.push({
      metric: 'section-miss-rate',
      value: pct(sectionMissRate),
      threshold: pct(THRESHOLDS.sectionMissRateMax),
      message:
        `Section-hit miss rate ${pct(sectionMissRate)} > threshold ${pct(THRESHOLDS.sectionMissRateMax)} ` +
        '— retrieval quality may have degraded; check embedding model and HNSW index',
    })
  }

  // ── Judge-error rate ──────────────────────────────────────────────────────
  const judgeErrorCount = faithfulnessTraces.filter((t) => t.errored).length
  const judgeErrorRate = faithfulnessTotal > 0 ? judgeErrorCount / faithfulnessTotal : null

  if (
    faithfulnessTotal >= THRESHOLDS.minTracesForRates &&
    judgeErrorRate !== null &&
    judgeErrorRate > THRESHOLDS.judgeErrorRateMax
  ) {
    alerts.push({
      metric: 'judge-error-rate',
      value: pct(judgeErrorRate),
      threshold: pct(THRESHOLDS.judgeErrorRateMax),
      message:
        `Judge error rate ${pct(judgeErrorRate)} > threshold ${pct(THRESHOLDS.judgeErrorRateMax)} ` +
        '— check Claude API health, prompt structure, and rate limits',
    })
  }

  // ── Faithfulness p50 / p90 ────────────────────────────────────────────────
  const validScores = faithfulnessTraces
    .filter((t) => !t.zeroClaim && !t.errored && t.score !== null)
    .map((t) => t.score as number)
    .sort((a, b) => a - b)

  const faithfulnessP50 = percentile(validScores, 0.5)
  const faithfulnessP90 = percentile(validScores, 0.9)

  if (faithfulnessP50 !== null && faithfulnessP50 < THRESHOLDS.faithfulnessP50Min) {
    alerts.push({
      metric: 'faithfulness-p50',
      value: fmt(faithfulnessP50),
      threshold: fmt(THRESHOLDS.faithfulnessP50Min),
      message:
        `Faithfulness p50=${fmt(faithfulnessP50)} < threshold=${fmt(THRESHOLDS.faithfulnessP50Min)} ` +
        '— median faithfulness below floor; check for prompt regression or model change',
    })
  }
  if (faithfulnessP90 !== null && faithfulnessP90 < THRESHOLDS.faithfulnessP90Min) {
    alerts.push({
      metric: 'faithfulness-p90',
      value: fmt(faithfulnessP90),
      threshold: fmt(THRESHOLDS.faithfulnessP90Min),
      message:
        `Faithfulness p90=${fmt(faithfulnessP90)} < threshold=${fmt(THRESHOLDS.faithfulnessP90Min)} ` +
        '— p90 below gate threshold; production scoring is degrading',
    })
  }

  // ── MODEL-DEPRECATION alerts ──────────────────────────────────────────────
  const unexpectedJudgeArr = [...unexpectedJudgeModels]
  const unexpectedEmbeddingArr = [...unexpectedEmbeddingModels]

  if (unexpectedJudgeArr.length > 0) {
    alerts.push({
      metric: 'model-deprecation',
      value: unexpectedJudgeArr.join(', '),
      threshold: EXPECTED_JUDGE_MODEL,
      message:
        `Judge model deprecation detected — traces carrying judgeModel=[${unexpectedJudgeArr.join(', ')}], ` +
        `expected "${EXPECTED_JUDGE_MODEL}". Scoring behaviour may have changed silently.`,
    })
  }
  if (unexpectedEmbeddingArr.length > 0) {
    alerts.push({
      metric: 'model-deprecation',
      value: unexpectedEmbeddingArr.join(', '),
      threshold: EXPECTED_EMBEDDING_MODEL,
      message:
        `Embedding model deprecation detected — traces carrying embeddingModel=[${unexpectedEmbeddingArr.join(', ')}], ` +
        `expected "${EXPECTED_EMBEDDING_MODEL}". Retrieval quality may have changed silently.`,
    })
  }

  return {
    windowDays,
    totalTraces,
    faithfulnessTraces: faithfulnessTotal,
    retrieveTraces: retrieveTotal,
    zeroClaimRate,
    sectionMissRate,
    judgeErrorRate,
    faithfulnessP50,
    faithfulnessP90,
    unexpectedJudgeModels: unexpectedJudgeArr,
    unexpectedEmbeddingModels: unexpectedEmbeddingArr,
    alerts,
    generatedAt: new Date().toISOString(),
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('[quality-report] DATABASE_URL is required')
    process.exit(1)
  }

  const windowDays = parseInt(process.env.WINDOW_DAYS ?? '30', 10)

  console.log('┌─────────────────────────────────────────────────────────────┐')
  console.log('│  quality report  —  scripts/observability/quality-report.ts  │')
  console.log('└─────────────────────────────────────────────────────────────┘')
  console.log(`  window: last ${windowDays} days`)

  const client = new Client({ connectionString: dbUrl })
  await client.connect()

  let report: QualityReport
  try {
    report = await computeQualityReport(client, windowDays)
  } finally {
    await client.end()
  }

  // ── Print report ───────────────────────────────────────────────────────────
  console.log(`\n  Total traces:          ${report.totalTraces}`)
  console.log(`  Faithfulness traces:   ${report.faithfulnessTraces}`)
  console.log(`  Retrieve traces:       ${report.retrieveTraces}`)
  console.log(`\n  Zero-claim rate:       ${pct(report.zeroClaimRate)}`)
  console.log(`  Section-hit miss rate: ${pct(report.sectionMissRate)}`)
  console.log(`  Judge-error rate:      ${pct(report.judgeErrorRate)}`)
  console.log(`\n  Faithfulness p50:      ${fmt(report.faithfulnessP50)}`)
  console.log(`  Faithfulness p90:      ${fmt(report.faithfulnessP90)}`)

  if (report.unexpectedJudgeModels.length > 0) {
    console.log(`\n  WARN unexpected judgeModel:     [${report.unexpectedJudgeModels.join(', ')}]`)
  }
  if (report.unexpectedEmbeddingModels.length > 0) {
    console.log(`\n  WARN unexpected embeddingModel: [${report.unexpectedEmbeddingModels.join(', ')}]`)
  }

  if (report.totalTraces < THRESHOLDS.minTracesForRates) {
    console.log(`\n  NOTE: only ${report.totalTraces} traces in window — rate metrics suppressed below n=${THRESHOLDS.minTracesForRates}`)
  }

  console.log('\n══════════════════════════════════════════════════════════════')
  if (report.alerts.length === 0) {
    console.log('  ✓  quality-report-green: all metrics within thresholds')
    console.log(JSON.stringify(report, null, 2))
    process.exit(0)
  } else {
    console.log(`  ✗  quality-report-red: ${report.alerts.length} alert(s)`)
    for (const a of report.alerts) {
      console.log(`       [${a.metric}] ${a.message}`)
    }
    console.log('\nFull report:')
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }
}

main().catch((err: Error) => {
  console.error('[quality-report] Unexpected error:', err)
  process.exit(1)
})
