// ── Multi-judge cost preview (SHA-167 N14) ───────────────────────────────────
//
// A score pass runs EVERY judge against EVERY patient, so its metered-call
// fan-out is `judges × patients`. This module is the single source for that
// arithmetic and the copy around it, reusing N8a's cost-preview pattern (state
// the bill BEFORE the run) so a multi-judge run is never a surprise charge.
//
// Pure functions only — no React, no network. The component layer renders these.

import type { OutputCardResult } from './useNotebookRun'

/**
 * Metered-call fan-out of one score pass: each judge calls once per patient that
 * produced gradeable output. Negatives are clamped to 0 so a malformed count can
 * never preview a negative bill.
 */
export function judgePassCalls(judges: number, patients: number): number {
  return Math.max(0, Math.trunc(judges)) * Math.max(0, Math.trunc(patients))
}

/**
 * The cost-preview line for a multi-judge score pass. Honest about the meter: a
 * free-tier pass draws the shared limit; a BYO-key pass bills the caller's own key
 * and is not metered against the free tier (mirrors PromptCell's N8a copy).
 */
export function judgeCostLine(judges: number, patients: number, hasKey: boolean): string {
  const calls = judgePassCalls(judges, patients)
  const jLabel = `${judges} judge${judges === 1 ? '' : 's'}`
  const pLabel = `${patients} patient${patients === 1 ? '' : 's'}`
  const callLabel = `${calls} ${calls === 1 ? 'call' : 'calls'}`
  const head = `A score pass runs every judge against every patient · ${jLabel} × ${pLabel} = ${callLabel}`
  return hasKey ? `${head} billed to your key (not metered)` : `${head} metered against the free tier`
}

/**
 * Count the patients in `order` that have gradeable output — the true judge
 * fan-out (a judge skips patients without a completed, non-empty output, so they
 * cost nothing). Both the per-cell and the aggregate previews read this, so the
 * stated bill matches what a Run will actually spend.
 */
export function countJudgeable(
  order: string[],
  results: Record<string, OutputCardResult>,
): number {
  return order.filter((id) => {
    const r = results[id]
    return Boolean(r) && r.status === 'done' && r.output.trim().length > 0
  }).length
}
