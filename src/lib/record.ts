// ── Stuff-mode record assembly + size guard (engine primitive) ───────────────
//
// The deterministic, offline core behind "assemble a patient's chunks into the
// single stuff-mode record the run grounds on" and the D3 record-size guard.
// Relocated out of the (now-deleted) workbench layer in N19 because it is ENGINE,
// not workbench UI: `GET /api/patients/sample` — which the notebook calls to draw
// authorable patients — depends on it. Everything here is pure and free (rule 20).
//
//   • D3 — random-N record-size guard. A sampled patient is eligible iff its
//          STUFF-mode record fits the assembly budget (12k input minus prompt/query
//          overhead) under O1's local, fail-closed token counter. The guard is what
//          makes "give me N random" hand out authorable skeletons, never
//          dead-on-arrival ones.

import { estimateInputTokens, MAX_INPUT_TOKENS } from '@/lib/tokens'

/**
 * Tokens reserved out of the 12k input budget for everything that is NOT the
 * record itself: the system prompt, the QUESTION wrapper, and a typical authored
 * query. S25 frames the assembly budget as "12k minus prompt/query overhead"; a
 * patient is eligible only if its record leaves room for that overhead. Biased
 * generous (fail-closed) so a borderline patient is excluded rather than handed
 * out as a skeleton that overflows at run time.
 */
export const ASSEMBLY_OVERHEAD_TOKENS = 500

/** The token budget a sampled patient's stuff-mode record must fit within (D3). */
export const RECORD_BUDGET_TOKENS = MAX_INPUT_TOKENS - ASSEMBLY_OVERHEAD_TOKENS

/** One chunk of a patient's record (the shape the chunks API returns). */
export interface RecordChunk {
  section: string
  ord: number
  text: string
}

/**
 * Assemble a patient's chunks into the single stuff-mode record string — the same
 * `[section]\n{text}` join, `\n\n---\n\n`-separated, that the generation/score path
 * treats as the stuff-mode record. This is what the guard measures and what the
 * record view renders. Chunks are assumed pre-sorted (section, ord); we do not
 * reorder so the assembled record is stable.
 */
export function assembleStuffRecord(chunks: RecordChunk[]): string {
  return chunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
}

/**
 * The local (margined) token estimate of a stuff-mode record. Uses O1's
 * fail-closed `estimateInputTokens` — never the count_tokens API (S25: no
 * per-sample round-trip).
 */
export function recordTokenEstimate(record: string): number {
  return estimateInputTokens(record)
}

/**
 * The D3 guard: does this patient's stuff-mode record fit the assembly budget?
 * A `true` here is the contract behind "5 random → 5 authorable skeletons, none
 * dead-on-arrival" (modulo the documented local-approximation under-count slip,
 * which degrades to the S25/S23 refunded app-fault path at run time, not here).
 */
export function recordFitsBudget(record: string): boolean {
  return recordTokenEstimate(record) <= RECORD_BUDGET_TOKENS
}
