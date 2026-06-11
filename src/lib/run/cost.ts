// ── Generation cost estimate (D8/D9 — single source for the µ$ math) ─────────
//
// Extracted from /api/run so the cache-cost assertion can test the exact formula
// the trace persists (O6b accept: cached path estimate < uncached within
// tolerance). Rates are Haiku 4.5 list prices; prompt-cache reads bill at ~0.1×
// input and cache writes at ~1.25× input (the D8 pricing model). usage
// promptTokens already EXCLUDES cached reads — only freshly-processed input is
// counted there — so the cache legs are added at their own multipliers.

export const INPUT_COST_PER_TOKEN = 0.8 / 1_000_000 // $0.80/1M input tokens
export const OUTPUT_COST_PER_TOKEN = 4.0 / 1_000_000 // $4.00/1M output tokens
export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_MULTIPLIER = 1.25

export interface GenUsage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Anthropic-side cost of one generation, cache legs included (no embedding leg). */
export function estimateGenCostUsd(u: GenUsage): number {
  return (
    u.promptTokens * INPUT_COST_PER_TOKEN +
    u.completionTokens * OUTPUT_COST_PER_TOKEN +
    (u.cacheReadTokens ?? 0) * INPUT_COST_PER_TOKEN * CACHE_READ_MULTIPLIER +
    (u.cacheWriteTokens ?? 0) * INPUT_COST_PER_TOKEN * CACHE_WRITE_MULTIPLIER
  )
}
