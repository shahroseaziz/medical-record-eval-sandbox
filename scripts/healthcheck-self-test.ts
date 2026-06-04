/**
 * scripts/healthcheck-self-test.ts — Verifies monitoring logic without any API calls
 *
 * Checks that:
 *   1. checkDriftBand fires an alert for an obviously out-of-band score
 *   2. checkDriftBand does NOT fire for an in-band score
 *   3. parseDataStream correctly extracts events from a Vercel AI SDK stream body
 *
 * Run via: npx tsx scripts/healthcheck-self-test.ts
 * Used by the canary-self-test CI job to catch regressions in monitoring logic.
 *
 * Exit codes: 0 (pass), 1 (fail)
 */

import { checkDriftBand, parseDataStream } from './healthcheck.js'

let failed = false

function assert(condition: boolean, msg: string): void {
  if (condition) {
    console.log(`  OK    ${msg}`)
  } else {
    console.error(`  FAIL  ${msg}`)
    failed = true
  }
}

// ── Test 1: band-exceeding score fires alert ──────────────────────────────────
// baseline mean=0.90, stdDev=0.01 → halfBand=max(0.05, 0.03)=0.05 → band [0.85, 0.95]
// score=0.50 is well outside the band → alert must fire
const alertFired = checkDriftBand('test-case', 0.50, 0.90, 0.01)
assert(alertFired !== null, 'band-exceeding score=0.50 fires alert (baseline=0.90 ± 0.05)')
if (alertFired) {
  assert(
    alertFired.message.includes('0.5000'),
    `alert message contains live score: "${alertFired.message}"`
  )
}

// ── Test 2: in-band score does NOT fire ───────────────────────────────────────
// score=0.92 is inside [0.85, 0.95] → no alert
const noAlert = checkDriftBand('test-case', 0.92, 0.90, 0.01)
assert(noAlert === null, 'in-band score=0.92 does not fire alert')

// ── Test 3: score exactly on band boundary — out-of-band ─────────────────────
// score=0.85 is at the lower bound → on-band (no alert expected)
// score=0.849 is just below the lower bound → alert
const onBoundary = checkDriftBand('test-case', 0.8499, 0.90, 0.01)
assert(onBoundary !== null, 'score=0.8499 just below lower bound fires alert')

// ── Test 4: minimum halfBand is 0.05 even with stdDev=0 ──────────────────────
// stdDev=0 → halfBand=max(0.05, 0)=0.05 → band [0.85, 0.95]
const noStdDev = checkDriftBand('zero-stddev', 0.50, 0.90, 0)
assert(noStdDev !== null, 'zero stdDev still applies minimum halfBand of 0.05')

// ── Test 5: parseDataStream extracts 2:-prefixed events ──────────────────────
const fakeBody = [
  '0:"text token"',
  '2:[{"type":"trace","trace":{"estCostUsd":0.001}}]',
  '2:[{"type":"eval","faithfulness":{"score":0.9,"claims":[]}}]',
  '3:"error message"',
  'd:{"finishReason":"stop"}',
  '',
].join('\n')

const events = parseDataStream(fakeBody)
assert(events.length === 2, `parseDataStream extracts 2 events (got ${events.length})`)
assert(
  events.some((e) => e.type === 'trace'),
  'parseDataStream finds trace event'
)
assert(
  events.some((e) => e.type === 'eval'),
  'parseDataStream finds eval event'
)

// ── Test 6: malformed 2:-line does not crash ──────────────────────────────────
const malformedBody = '2:not-valid-json\n2:[{"type":"ok"}]\n'
const malformedEvents = parseDataStream(malformedBody)
assert(malformedEvents.length === 1, 'malformed 2: line is skipped gracefully')

// ── Result ────────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════════')
if (failed) {
  console.error('  ✗  self-test FAILED')
  process.exit(1)
} else {
  console.log('  ✓  self-test passed')
  process.exit(0)
}
