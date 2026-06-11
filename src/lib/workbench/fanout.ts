// ── Selective fan-out (O6b / S23) ─────────────────────────────────────────────
//
// Per-case selection for Generate/Score actions — no all-or-nothing fan-outs
// (the walk evidence: "Regenerate all (4)" burned 40% of an hourly budget per
// prompt tweak). This module is the pure logic behind the bench's checkboxes:
// which cases run, how many metered judge calls that implies, what it roughly
// costs (D9: computed at runtime from the µ$ rates, never hardcoded copy), and
// the deterministic-first execution order (E29c — free scorers run and render
// before any metered judge call books; the cost-hierarchy pedagogy embodied in
// execution order).

import type { BenchCaseV4, BenchFieldScorer } from '@/lib/cases'
import { estimateInputTokens, MAX_OUTPUT_TOKENS } from '@/lib/tokens'
import { INPUT_COST_PER_TOKEN, OUTPUT_COST_PER_TOKEN } from '@/lib/run/cost'

/** Metered model calls per scorer: faithfulness = extract + verdict, judge = 1, diff = 0. */
const CALLS_PER_SCORER: Record<BenchFieldScorer, number> = {
  faithfulness: 2,
  'reference-judge': 1,
  'structured-diff': 0,
}

/** How many metered judge calls scoring this case will book. */
export function meteredCallsForCase(c: Pick<BenchCaseV4, 'fieldScorers'>): number {
  return Object.values(c.fieldScorers ?? {}).reduce(
    (n, scorer) => n + (CALLS_PER_SCORER[scorer] ?? 0),
    0,
  )
}

/**
 * Deterministic-first execution order (E29c): cases whose every field scores
 * free/client-side come first — their results render instantly, before any
 * metered call books. Stable within each class (preserves input order).
 */
export function deterministicFirst<T>(items: T[], calls: (item: T) => number): T[] {
  const free: T[] = []
  const metered: T[] = []
  for (const item of items) (calls(item) === 0 ? free : metered).push(item)
  return [...free, ...metered]
}

export interface FanoutSummary {
  /** Selected case count. */
  k: number
  /** Total metered judge calls scoring the selection would book. */
  meteredCalls: number
  /** Rough Anthropic-side cost of scoring the selection (judge legs only). */
  estUsd: number
}

/**
 * Pre-commit summary for the Score action (D9). The judge sees roughly the
 * case's grounding as input and is bounded by MAX_OUTPUT_TOKENS of output, so
 * each metered call is estimated as grounding-input + full output allowance at
 * the list rates. An estimate for orientation before booking — not a bill.
 */
export function scoreSelectionSummary(
  cases: BenchCaseV4[],
  selected: ReadonlySet<string>,
  groundingFor: (c: BenchCaseV4) => string,
): FanoutSummary {
  let meteredCalls = 0
  let estUsd = 0
  let k = 0
  for (const c of cases) {
    if (!selected.has(c.id)) continue
    k++
    const calls = meteredCallsForCase(c)
    meteredCalls += calls
    if (calls > 0) {
      const inputTokens = estimateInputTokens(groundingFor(c))
      estUsd +=
        calls * (inputTokens * INPUT_COST_PER_TOKEN + MAX_OUTPUT_TOKENS * OUTPUT_COST_PER_TOKEN)
    }
  }
  return { k, meteredCalls, estUsd }
}
