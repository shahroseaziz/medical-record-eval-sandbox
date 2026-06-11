// ── E25 firewall extension — expected fields never reach generation ──────────
//
// The E4/E13 firewall (expectedOutput is firewalled from faithfulness grounding)
// grew a new surface in cycle 3: hand-authored `expectedProse` / `expectedStructured`
// and the per-field scorer assignment are ANSWER-KEY data. They must never enter a
// generation prompt — a generator that sees the expected answer is no longer being
// evaluated, it is being fed the key.
//
// `buildBenchGenerationRequest` is the single chokepoint every bench regeneration
// routes through: `useGenerationRun.generateOneCase` builds the POST /api/run body
// here, and BOTH live-regeneration entry points (Workbench and GoldenSetBuilder,
// via `gen.run`/`gen.resume`) fan out through that one hook. It projects a case into
// the run request by an explicit allow-list of generation-relevant fields; the
// expected-output fields are STRUCTURALLY absent (never copied), not merely filtered.
// The firewall test (S19 marker grep over the assembled prompt + the REAL `assembleRunTrace`
// persistence path) plants sentinels in answer-key fields and asserts they never appear
// downstream.

import type { RunRequest, RunMode } from '@/app/api/run/types'

/** The case fields that are answer-key data and must never cross into generation. */
export const EXPECTED_FIELD_KEYS = ['expectedProse', 'expectedStructured', 'fieldScorers'] as const

/**
 * The generation-relevant subset of a case the request is built from — named to
 * match the live `GenerationCase` so production callers pass it directly. Declaring
 * it narrowly is the firewall: a wider case object (one carrying expected fields)
 * cannot leak an answer-key field through, because only these keys are ever read.
 */
export interface BenchGenerationCase {
  patientId: string
  query: string
  mode: RunMode
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
  /** Whether the judge should use the caller's BYO key (set per live run). */
  judgeUsesByo?: boolean
}

/**
 * Project a case into a generation RunRequest. ONLY the allow-listed
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
    query: c.query,
    mode: c.mode,
  }
  if (c.mode === 'stuff' && opts.record !== undefined) req.record = opts.record
  if (c.mode === 'retrieve' && opts.k !== undefined) req.k = opts.k
  if (opts.generationPrompt) req.generationPrompt = opts.generationPrompt
  if (opts.generateOnly) req.generateOnly = true
  if (opts.judgeUsesByo !== undefined) req.judgeUsesByo = opts.judgeUsesByo
  return req
}
