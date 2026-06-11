// ── E25 firewall extension — expected fields never reach generation ──────────
//
// The E4/E13 firewall (expectedOutput is firewalled from faithfulness grounding)
// grew a new surface in cycle 3: hand-authored `expectedProse` / `expectedStructured`
// and the per-field scorer assignment are ANSWER-KEY data. They must never enter a
// generation prompt — a generator that sees the expected answer is no longer being
// evaluated, it is being fed the key.
//
// `buildBenchGenerationRequest` is the single chokepoint every bench regeneration
// routes through. It projects a bench case into the run request by an explicit
// allow-list of generation-relevant fields; the expected-output fields are
// STRUCTURALLY absent (never copied), not merely filtered. The firewall test
// (S19 marker grep over the assembled prompt + persisted trace) plants sentinels in
// the expected fields and asserts they never appear downstream.

import type { RunRequest, RunMode } from '@/app/api/run/types'

/** The case fields that are answer-key data and must never cross into generation. */
export const EXPECTED_FIELD_KEYS = ['expectedProse', 'expectedStructured', 'fieldScorers'] as const

/** The generation-relevant subset of a bench case the request is built from. */
export interface BenchGenerationCase {
  patientId: string
  taskPrompt: string
  ragMode: RunMode
}

export interface BenchGenerationOptions {
  /** Stuff-mode record text (retrieve mode ignores it). */
  record?: string
  /** Retrieve-mode chunk count. */
  k?: number
  /** Caller-supplied generation prompt (the one live knob). */
  generationPrompt?: string
  /** Generate-only fan-out: skip the judge call. */
  generateOnly?: boolean
}

/**
 * Project a bench case into a generation RunRequest. ONLY the allow-listed
 * generation-relevant fields are copied; `expectedProse`, `expectedStructured`,
 * and `fieldScorers` have no path into the returned object. Accepts the narrow
 * `BenchGenerationCase` shape precisely so a wider case object cannot leak an
 * expected field through object spread.
 */
export function buildBenchGenerationRequest(
  c: BenchGenerationCase,
  opts: BenchGenerationOptions = {},
): RunRequest {
  const req: RunRequest = {
    patientId: c.patientId,
    query: c.taskPrompt,
    mode: c.ragMode,
  }
  if (c.ragMode === 'stuff' && opts.record !== undefined) req.record = opts.record
  if (opts.k !== undefined) req.k = opts.k
  if (opts.generationPrompt) req.generationPrompt = opts.generationPrompt
  if (opts.generateOnly) req.generateOnly = true
  return req
}
