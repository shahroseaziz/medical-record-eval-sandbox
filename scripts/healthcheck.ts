/**
 * scripts/healthcheck.ts — Production health check + drift canary
 *
 * Checks:
 *   [1] Cold-load static assertion (DB-free)
 *       GET / → 200, HTML contains PASS label, FAIL label, "Pass rate:" text.
 *       The homepage reads evals/results/seed-baseline.json at render time — no DB
 *       required — so this passes even when Neon is suspended.
 *
 *   [2] Live free-tier run
 *       POST /api/run (no x-byo-api-key header → production free-tier path).
 *       Assert: RunTrace.tokens.estCostUsd > 0. Logs full response.
 *
 *   [3] Drift canary
 *       Re-run all 7 seed cases through the deployed /api/run endpoint.
 *       Cases with preauthoredOutput are run for MODEL-DEPRECATION checks only —
 *       score-band checks are skipped because the deployed endpoint produces fresh
 *       faithful output that is not comparable to the intentionally low baseline
 *       fail score stored for those cases.
 *       Alerts when:
 *         • live faithfulness score exits baseline meanScore ± max(0.05, 3·σ)
 *         • judgeModel or embeddingModel in the trace differs from constants
 *           (MODEL-DEPRECATION failure mode — Anthropic/Voyage may silently redirect
 *            a deprecated model to a successor with different scoring behaviour)
 *
 * Env:
 *   PROD_URL           Production URL, e.g. https://your-app.vercel.app  (required)
 *   ANTHROPIC_API_KEY  BYO key used for drift canary (required when SKIP_DRIFT != 1)
 *   SKIP_LIVE          Set to "1" to skip live run check
 *   SKIP_DRIFT         Set to "1" to skip drift canary
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCcda } from '../src/lib/ccda/index.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname, '..')
const BASELINE_PATH = join(REPO_ROOT, 'evals/results/seed-baseline.json')
const CASES_PATH = join(REPO_ROOT, 'evals/golden/seed-cases.json')
const FIXTURE_DIR = join(REPO_ROOT, 'src/lib/ccda/__fixtures__')

// MODEL-DEPRECATION: if the deployed trace reports a different judge/embedding model,
// scoring behaviour may have silently changed → alert immediately.
export const EXPECTED_JUDGE_MODEL = 'claude-haiku-4-5-20251001'
export const EXPECTED_EMBEDDING_MODEL = 'voyage-3.5'

const FAITHFULNESS_THRESHOLD = 0.85

// Minimum half-band for drift detection (avoids over-sensitivity on low-variance cases)
const DRIFT_BAND_MIN_HALF = 0.05

const REQUEST_TIMEOUT_MS = 120_000
const COLD_LOAD_TIMEOUT_MS = 30_000

// ── Types ─────────────────────────────────────────────────────────────────────

interface SeedCase {
  id: string
  taskPrompt: string
  patientId: string
  ragMode: 'retrieve' | 'stuff'
  expectedOutput: string
  referenceLabel: 'pass' | 'fail'
  requiredSections?: string[]
  preauthoredOutput?: string
  scorers: string[]
}

interface BaselineCase {
  caseId: string
  meanScore: number | null
  scoreStdDev: number | null
  referenceLabel: 'pass' | 'fail'
  trace: { output: string; retrievedChunks?: Array<{ section: string; text: string }> }
  scorerResults: Array<{ scorer: string; score: number | null; zeroClaimFlag?: boolean }>
}

interface BaselineData {
  judgeModel: string
  embeddingModel: string
  k: number
  cases: BaselineCase[]
  aggregate: { passRate: number | null; n: number }
}

export interface HealthCheckAlert {
  check: string
  message: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stdout.write(msg + '\n')
}

function ok(msg: string): void {
  log(`  OK    ${msg}`)
}

function alert(msg: string): void {
  log(`  ALERT ${msg}`)
}

/**
 * Parse Vercel AI SDK v4 data stream body into event objects.
 * Lines starting with "2:" contain JSON arrays of writeData() payloads.
 */
export function parseDataStream(body: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of body.split('\n')) {
    if (!line.startsWith('2:')) continue
    try {
      const parsed: unknown = JSON.parse(line.slice(2))
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item === 'object') events.push(item as Record<string, unknown>)
        }
      } else if (parsed && typeof parsed === 'object') {
        events.push(parsed as Record<string, unknown>)
      }
    } catch {
      // malformed line — skip
    }
  }
  return events
}

/**
 * POST /api/run and return the parsed trace + raw body.
 * Returns { error } on network failure or missing trace event.
 */
async function runOne(
  prodUrl: string,
  body: Record<string, unknown>,
  byoKey: string | undefined
): Promise<{ trace: Record<string, unknown>; events: Record<string, unknown>[]; rawBody: string } | { error: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (byoKey) headers['x-byo-api-key'] = byoKey

  let resp: Response
  try {
    resp = await fetch(`${prodUrl}/api/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return { error: `network error: ${err instanceof Error ? err.message : String(err)}` }
  }

  const rawBody = await resp.text()

  if (!resp.ok) {
    return { error: `HTTP ${resp.status}: ${rawBody.slice(0, 300)}` }
  }

  // Check for in-stream errors (e.g. over-context, spend cap)
  const events = parseDataStream(rawBody)
  const errEvent = events.find((e) => e.type === 'error')
  if (errEvent) {
    return { error: `stream error: ${(errEvent.message as string | undefined) ?? JSON.stringify(errEvent)}` }
  }

  const traceEvent = events.find((e) => e.type === 'trace')
  if (!traceEvent) {
    return { error: `no trace event in response. body head: ${rawBody.slice(0, 400)}` }
  }

  return {
    trace: traceEvent.trace as Record<string, unknown>,
    events,
    rawBody,
  }
}

/**
 * Drift band check.
 * Returns an alert when liveScore exits [mean - halfBand, mean + halfBand].
 * Exported so unit tests can inject a band-exceeding score to verify the alert fires.
 */
export function checkDriftBand(
  caseId: string,
  liveScore: number,
  baselineMean: number,
  baselineStdDev: number
): HealthCheckAlert | null {
  const halfBand = Math.max(DRIFT_BAND_MIN_HALF, 3 * baselineStdDev)
  const lo = baselineMean - halfBand
  const hi = baselineMean + halfBand
  if (liveScore < lo || liveScore > hi) {
    return {
      check: 'drift-band',
      message:
        `Case ${caseId}: liveScore=${liveScore.toFixed(4)} outside band ` +
        `[${lo.toFixed(4)}, ${hi.toFixed(4)}] ` +
        `(baseline=${baselineMean.toFixed(4)} ± ${halfBand.toFixed(4)})`,
    }
  }
  return null
}

const _recordCache = new Map<string, string>()

function getPatientRecord(patientId: string): string {
  if (_recordCache.has(patientId)) return _recordCache.get(patientId)!
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.xml'))
  for (const f of files) {
    const xml = readFileSync(join(FIXTURE_DIR, f), 'utf-8')
    const result = parseCcda(xml)
    if (result.patientId === patientId) {
      const text = result.sections
        .map((s) => `[${s.section.toUpperCase()}]\n${s.text}`)
        .join('\n\n---\n\n')
      _recordCache.set(patientId, text)
      return text
    }
  }
  throw new Error(`Patient ${patientId} not found in ${FIXTURE_DIR}`)
}

// ── Check [1]: Cold-load static assertion ────────────────────────────────────

async function coldLoadCheck(prodUrl: string): Promise<HealthCheckAlert[]> {
  const alerts: HealthCheckAlert[] = []

  let resp: Response
  try {
    resp = await fetch(prodUrl, { signal: AbortSignal.timeout(COLD_LOAD_TIMEOUT_MS) })
  } catch (err) {
    alerts.push({
      check: 'cold-load',
      message: `GET / failed: ${err instanceof Error ? err.message : String(err)}`,
    })
    return alerts
  }

  if (!resp.ok) {
    alerts.push({ check: 'cold-load', message: `GET / returned HTTP ${resp.status}` })
    return alerts
  }

  const body = await resp.text()

  // The EvalScorecard renders "PASS" and "FAIL" badge spans from seed-baseline.json
  // (a static file bundled at build time). DB is not needed for these assertions.
  if (!body.includes('PASS')) {
    alerts.push({
      check: 'cold-load',
      message: 'Homepage missing "PASS" label — static scorecard not rendered (check seed-baseline.json is bundled)',
    })
  }
  if (!body.includes('FAIL')) {
    alerts.push({
      check: 'cold-load',
      message: 'Homepage missing "FAIL" label — static fail case not rendered',
    })
  }
  if (!body.includes('Pass rate:')) {
    alerts.push({
      check: 'cold-load',
      message: 'Homepage missing "Pass rate:" — aggregate scorecard not rendered',
    })
  }

  return alerts
}

// ── Check [2]: Live free-tier run ────────────────────────────────────────────

async function liveRunCheck(prodUrl: string): Promise<HealthCheckAlert[]> {
  const alerts: HealthCheckAlert[] = []

  // Use a retrieve case — no large record payload; tests the full pipeline end-to-end
  // including Voyage embedding, pgvector retrieval, Claude generation, and judge scoring.
  const result = await runOne(
    prodUrl,
    {
      patientId: 'e0de7b0a-c40b-6467-c099-0f9467be6c0a',
      query:
        'Based ONLY on the clinical sections provided, describe the vital signs documented for this patient. Report only values explicitly present in the context.',
      mode: 'retrieve',
      k: 6,
    },
    undefined // no x-byo-api-key → exercises the free-tier spending cap path
  )

  if ('error' in result) {
    alerts.push({ check: 'live-run', message: `Run failed: ${result.error}` })
    return alerts
  }

  log('\n[live-run] Full response trace:')
  log(JSON.stringify(result.trace, null, 2))

  const tokens = result.trace.tokens as Record<string, number> | undefined
  const estCostUsd = tokens?.estCostUsd ?? 0

  if (estCostUsd <= 0) {
    alerts.push({
      check: 'live-run',
      message: `estCostUsd=${estCostUsd} — expected > 0; generation may not have run`,
    })
  } else {
    ok(`estCostUsd=${estCostUsd.toFixed(6)} (live free-tier run populated)`)
  }

  // Verify trace is populated
  const output = result.trace.output as string | undefined
  if (!output || output.length === 0) {
    alerts.push({ check: 'live-run', message: 'trace.output is empty' })
  }

  return alerts
}

// ── Check [3]: Drift canary ───────────────────────────────────────────────────

async function driftCanary(prodUrl: string, byoKey: string): Promise<HealthCheckAlert[]> {
  const alerts: HealthCheckAlert[] = []

  let baseline: BaselineData
  let seedCases: SeedCase[]
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8'))
    seedCases = JSON.parse(readFileSync(CASES_PATH, 'utf-8'))
  } catch (err) {
    alerts.push({
      check: 'drift-canary',
      message: `Failed to load baseline/cases: ${err instanceof Error ? err.message : String(err)}`,
    })
    return alerts
  }

  const baselineMap = new Map<string, BaselineCase>(baseline.cases.map((c) => [c.caseId, c]))

  for (const sc of seedCases) {
    // preauthoredOutput cases are run only for MODEL-DEPRECATION checks.
    // Score-band and faithfulness checks are skipped: the deployed endpoint generates
    // fresh output for these designed-fail cases, which would be faithfully scored high
    // and produce false-positive band alerts against the intentionally low baseline.
    const preauthored = Boolean(sc.preauthoredOutput)

    const bc = baselineMap.get(sc.id)
    if (!bc) {
      alerts.push({ check: 'drift-canary', message: `Case ${sc.id} not found in baseline` })
      continue
    }

    log(`\n[drift] Running ${sc.id} (mode=${sc.ragMode}, scorers=${sc.scorers.join(',')})${preauthored ? ' [model-deprecation only]' : ''}`)

    const requestBody: Record<string, unknown> = {
      patientId: sc.patientId,
      query: sc.taskPrompt,
      mode: sc.ragMode,
      k: 6,
    }

    if (sc.ragMode === 'stuff') {
      requestBody.record = getPatientRecord(sc.patientId)
    }

    const result = await runOne(prodUrl, requestBody, byoKey)

    if ('error' in result) {
      alerts.push({ check: 'drift-canary', message: `Case ${sc.id} run failed: ${result.error}` })
      continue
    }

    log(`[drift] ${sc.id} trace:`)
    log(JSON.stringify(result.trace, null, 2))

    // ── MODEL-DEPRECATION checks ────────────────────────────────────────────
    // If Anthropic or Voyage deprecates a model and silently redirects to a
    // successor, scoring behaviour changes without any code change. Detect this
    // by comparing trace model names against pinned constants.
    // Runs for ALL cases including preauthored ones.
    const judgeModel = result.trace.judgeModel as string | undefined
    const embeddingModel = result.trace.embeddingModel as string | undefined

    if (judgeModel && judgeModel !== EXPECTED_JUDGE_MODEL) {
      alerts.push({
        check: 'model-deprecation',
        message:
          `Case ${sc.id}: judgeModel="${judgeModel}" ≠ expected="${EXPECTED_JUDGE_MODEL}" — ` +
          'possible model deprecation; scoring behaviour may have changed',
      })
    }
    if (
      embeddingModel &&
      embeddingModel !== EXPECTED_EMBEDDING_MODEL &&
      embeddingModel !== 'none'
    ) {
      alerts.push({
        check: 'model-deprecation',
        message:
          `Case ${sc.id}: embeddingModel="${embeddingModel}" ≠ expected="${EXPECTED_EMBEDDING_MODEL}" — ` +
          'possible model deprecation; retrieval quality may have changed',
      })
    }

    // Skip score-based checks for preauthored cases (false-positive avoidance).
    if (preauthored) {
      ok(`${sc.id}: model-deprecation checks done (score-band skipped — preauthored case)`)
      continue
    }

    // ── Faithfulness score drift ────────────────────────────────────────────
    if (sc.scorers.includes('faithfulness')) {
      const evalEvent = result.events.find((e) => e.type === 'eval')
      const faithfulness = evalEvent?.faithfulness as Record<string, unknown> | undefined

      if (!faithfulness) {
        alerts.push({ check: 'drift-canary', message: `Case ${sc.id}: no faithfulness result in stream` })
        continue
      }

      if (faithfulness.errored) {
        alerts.push({
          check: 'drift-canary',
          message: `Case ${sc.id}: faithfulness scorer errored — ${(faithfulness.errorMessage as string | undefined) ?? 'unknown'}`,
        })
        continue
      }

      const liveScore = faithfulness.score as number | null
      const zeroClaimFlag = faithfulness.zeroClaimFlag as boolean | undefined

      if (zeroClaimFlag) {
        ok(`${sc.id}: zeroClaimFlag — excluded from band check (same as baseline)`)
        continue
      }

      if (liveScore === null) {
        alerts.push({ check: 'drift-canary', message: `Case ${sc.id}: null faithfulness score` })
        continue
      }

      ok(`${sc.id}: liveScore=${liveScore.toFixed(4)}`)

      // Band check — fires if score exits meanScore ± max(0.05, 3·σ)
      if (bc.meanScore !== null) {
        const v = checkDriftBand(sc.id, liveScore, bc.meanScore, bc.scoreStdDev ?? 0)
        if (v) {
          alerts.push(v)
        } else {
          const halfBand = Math.max(DRIFT_BAND_MIN_HALF, 3 * (bc.scoreStdDev ?? 0))
          ok(`${sc.id}: within band ±${halfBand.toFixed(4)} of baseline=${bc.meanScore.toFixed(4)}`)
        }
      }

      // Off-band invariant: pass cases must score above threshold, fail cases below
      if (sc.referenceLabel === 'pass' && liveScore < FAITHFULNESS_THRESHOLD) {
        alerts.push({
          check: 'drift-canary',
          message: `Case ${sc.id} (referenceLabel=pass): liveScore=${liveScore.toFixed(4)} < threshold=${FAITHFULNESS_THRESHOLD}`,
        })
      }
    }

    // ── Contains check (run locally from trace output) ──────────────────────
    if (sc.scorers.includes('contains') && sc.expectedOutput) {
      const output = (result.trace.output as string | undefined) ?? ''
      if (!output.toLowerCase().includes(sc.expectedOutput.toLowerCase())) {
        alerts.push({
          check: 'drift-canary',
          message: `Case ${sc.id}: output does not contain "${sc.expectedOutput}"`,
        })
      } else {
        ok(`${sc.id}: contains "${sc.expectedOutput}" ✓`)
      }
    }

    // ── Section-hit check ───────────────────────────────────────────────────
    if (sc.scorers.includes('section-hit') && sc.ragMode === 'retrieve') {
      const evalEvent = result.events.find((e) => e.type === 'eval')
      const sectionHit = evalEvent?.sectionHit as Record<string, unknown> | undefined
      const hitScore = sectionHit?.score as number | null | undefined

      if (hitScore !== 1) {
        const missing = (sectionHit?.missingSections as string[] | undefined) ?? []
        alerts.push({
          check: 'drift-canary',
          message: `Case ${sc.id}: section-hit=${hitScore ?? 'null'}, missing=[${missing.join(', ')}]`,
        })
      } else {
        ok(`${sc.id}: section-hit=1 ✓`)
      }
    }
  }

  return alerts
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const prodUrl = process.env.PROD_URL?.replace(/\/$/, '')
  if (!prodUrl) {
    log('ERROR: PROD_URL environment variable is required')
    process.exit(1)
  }

  const skipLive = process.env.SKIP_LIVE === '1'
  const skipDrift = process.env.SKIP_DRIFT === '1'

  log('┌─────────────────────────────────────────────────────────────┐')
  log('│  production health check  —  scripts/healthcheck.ts          │')
  log('└─────────────────────────────────────────────────────────────┘')
  log(`  PROD_URL:    ${prodUrl}`)
  log(`  skip_live:   ${skipLive}`)
  log(`  skip_drift:  ${skipDrift}`)

  const allAlerts: HealthCheckAlert[] = []

  // [1] Cold-load assertion (always runs — DB-free)
  log('\n[1] Cold-load static assertion (DB-free)')
  const coldAlerts = await coldLoadCheck(prodUrl)
  allAlerts.push(...coldAlerts)
  if (coldAlerts.length === 0) ok('Homepage renders PASS, FAIL, and pass-rate with no DB required')
  else coldAlerts.forEach((a) => alert(a.message))

  // [2] Live free-tier run
  if (!skipLive) {
    log('\n[2] Live free-tier run')
    const liveAlerts = await liveRunCheck(prodUrl)
    allAlerts.push(...liveAlerts)
    if (liveAlerts.length > 0) liveAlerts.forEach((a) => alert(a.message))
  } else {
    log('\n[2] Live free-tier run — SKIPPED')
  }

  // [3] Drift canary
  if (!skipDrift) {
    const byoKey = process.env.ANTHROPIC_API_KEY
    if (!byoKey) {
      allAlerts.push({
        check: 'drift-canary',
        message: 'ANTHROPIC_API_KEY required for drift canary',
      })
      alert('ANTHROPIC_API_KEY required for drift canary')
    } else {
      log('\n[3] Drift canary (re-running 7 seed cases; preauthored case: model-deprecation only)')
      const driftAlerts = await driftCanary(prodUrl, byoKey)
      allAlerts.push(...driftAlerts)
      if (driftAlerts.length === 0) ok('All drift checks passed — no score band or model config drift detected')
      else driftAlerts.forEach((a) => alert(`[${a.check}] ${a.message}`))
    }
  } else {
    log('\n[3] Drift canary — SKIPPED')
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  log('\n══════════════════════════════════════════════════════════════')
  if (allAlerts.length === 0) {
    log('  ✓  healthcheck-green: all checks passed')
    process.exit(0)
  } else {
    log(`  ✗  healthcheck-red: ${allAlerts.length} alert(s)`)
    for (const a of allAlerts) {
      log(`       [${a.check}] ${a.message}`)
    }
    process.exit(1)
  }
}

const _isMain = fileURLToPath(import.meta.url) === process.argv[1]
if (_isMain) {
  main().catch((err: Error) => {
    console.error('[healthcheck] Unexpected error:', err)
    process.exit(1)
  })
}
