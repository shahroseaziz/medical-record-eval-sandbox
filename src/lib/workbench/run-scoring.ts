// ── Run scoring — grade runs.current.outputs (O7b / S22 / E27) ───────────────
//
// The read-back half of the round-trip: scoring CONSUMES `runs.current.outputs`
// (the freshly regenerated text + the grounding it was captured against, E19) and
// produces a per-case `RowResult` that `persistScore` writes into
// `runs.current.scores`. There is no display-only path — the score is computed over
// the output the run actually generated, not an authored/frozen capture.
//
// Dispatch mirrors the GoldenSetBuilder fan-out (the production scorer path), but
// keyed off the case's `fieldScorers` map (O4's derived-with-override assignment,
// E25) and run over a `BenchRunOutput` rather than a UserCaseV3:
//   - structured-diff  → deterministic, client-side, free (no model call)
//   - reference-judge  → POST /api/score-reference (meaning-equivalence judge)
//   - faithfulness     → POST /api/score (grounding faithfulness judge)
// A 429 on any judge field aborts the row and bubbles up so the pass stops
// gracefully and resumably (the surviving outputs can be re-scored later, S22).
//
// The HTTP seam is injected (`PostJson`) so the round-trip e2e can fixture the model
// calls deterministically (D15 record-replay — no live calls in CI).

import { scoreRow, type FieldScoreOutcome, type RowResult } from '@/lib/eval/row-aggregate'
import { scoreStructuredDiff } from '@/lib/eval/scorers/structured-diff'
import type { EvalCase } from '@/lib/eval/types'
import type { Thresholds } from '@/lib/eval/thresholds'
import { getByoHeaders } from '@/components/ApiKeyInput'
import type { BenchCaseV4, BenchRunOutput, CapturedGrounding } from '@/lib/cases'

const SCORE_TIMEOUT_MS = 30_000

/** Result of scoring one case's run output: a row (null when throttled) + the 429 flag. */
export interface ScoreCaseOutcome {
  /** The rolled-up row, or null when a judge field was rate-limited (nothing to record). */
  row: RowResult | null
  rateLimited: boolean
}

/** Minimal POST seam, injectable so the model calls can be fixtured in tests/e2e. */
export type PostJson = (
  url: string,
  body: unknown,
) => Promise<{ status: number; data: unknown | null }>

interface ScoreAPIResponse {
  score: number | null
  zeroClaimFlag?: boolean
  errored?: boolean
}

interface ScoreReferenceAPIResponse {
  score: number | null
  errored?: boolean
}

/** Assemble the grounding the output was captured against into the judge's context string. */
export function assembleCapturedGrounding(cg: CapturedGrounding): string {
  if (cg.mode === 'retrieve' && cg.chunks) {
    return cg.chunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
  }
  return cg.record ?? ''
}

/** Default HTTP seam — the real network POST (timeout-bounded, BYO-key aware). */
export const defaultPostJson: PostJson = async (url, body) => {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), SCORE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getByoHeaders() },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (res.status === 429) return { status: 429, data: null }
    if (!res.ok) return { status: res.status, data: null }
    return { status: res.status, data: await res.json() }
  } catch {
    return { status: 0, data: null }
  } finally {
    clearTimeout(timeoutId)
  }
}

// Grounding faithfulness: scores the regenerated output against the grounding it was
// produced with (E19 — its OWN captured context, no drift-prone re-fetch).
async function scoreFaithfulnessField(
  output: BenchRunOutput,
  post: PostJson,
): Promise<{ outcome: FieldScoreOutcome; rateLimited: boolean }> {
  const grounding = assembleCapturedGrounding(output.capturedGrounding)
  if (!grounding || !output.text) {
    return {
      outcome: { field: 'prose', scorer: 'faithfulness', score: null, skipped: true },
      rateLimited: false,
    }
  }
  const { status, data } = await post('/api/score', {
    source: 'captured',
    capturedOutput: output.text,
    capturedGrounding: grounding,
  })
  if (status === 429) {
    return {
      outcome: { field: 'prose', scorer: 'faithfulness', score: null, rateLimited: true },
      rateLimited: true,
    }
  }
  if (data === null) {
    return {
      outcome: { field: 'prose', scorer: 'faithfulness', score: null, errored: true },
      rateLimited: false,
    }
  }
  const d = data as ScoreAPIResponse
  return {
    outcome: {
      field: 'prose',
      scorer: 'faithfulness',
      score: d.score ?? null,
      zeroClaimFlag: d.zeroClaimFlag ?? false,
      errored: d.errored ?? false,
    },
    rateLimited: false,
  }
}

// Reference judge: scores the regenerated output against the case's authored
// expected prose for meaning-equivalence. Skipped when no expected prose exists.
async function scoreReferenceField(
  benchCase: BenchCaseV4,
  output: BenchRunOutput,
  post: PostJson,
): Promise<{ outcome: FieldScoreOutcome; rateLimited: boolean }> {
  const expected = benchCase.expectedProse
  if (!expected || !output.text) {
    return {
      outcome: { field: 'prose', scorer: 'reference-judge', score: null, skipped: true },
      rateLimited: false,
    }
  }
  const { status, data } = await post('/api/score-reference', {
    actual: output.text,
    expected,
  })
  if (status === 429) {
    return {
      outcome: { field: 'prose', scorer: 'reference-judge', score: null, rateLimited: true },
      rateLimited: true,
    }
  }
  if (data === null) {
    return {
      outcome: { field: 'prose', scorer: 'reference-judge', score: null, errored: true },
      rateLimited: false,
    }
  }
  const d = data as ScoreReferenceAPIResponse
  return {
    outcome: {
      field: 'prose',
      scorer: 'reference-judge',
      score: d.score,
      errored: d.errored ?? false,
    },
    rateLimited: false,
  }
}

// Structured diff: deterministic, client-side F1 of the regenerated output (parsed
// as structured JSON) against the case's authored expected structured output.
// Skipped when there is no expected structured value or nothing to score.
function scoreStructuredField(
  benchCase: BenchCaseV4,
  output: BenchRunOutput,
): { outcome: FieldScoreOutcome; rateLimited: boolean } {
  const expected = benchCase.expectedStructured
  if (expected == null || (Array.isArray(expected) && expected.length === 0)) {
    return {
      outcome: { field: 'structured', scorer: 'structured-diff', score: null, skipped: true },
      rateLimited: false,
    }
  }
  const evalCase: EvalCase = {
    id: benchCase.id,
    patientId: benchCase.patientId,
    query: benchCase.taskPrompt,
    output: output.text,
    mode: benchCase.ragMode,
    expectedStructured: expected as unknown as Record<string, unknown>,
  }
  const result = scoreStructuredDiff(evalCase)
  return {
    outcome: {
      field: 'structured',
      scorer: 'structured-diff',
      score: result.score,
      skipped: result.score === null,
    },
    rateLimited: false,
  }
}

/**
 * Score one case's run output into a `RowResult` by running each scorer the case's
 * `fieldScorers` assigns. Dispatch is on the SCORER (not the field key) so the run
 * fingerprint's assignment labels (`claims`/`prose`/`structured`) all route to the
 * right grader. A throttled judge field aborts the row (returns `row: null,
 * rateLimited: true`) so the caller can stop and offer resume.
 */
export async function scoreRunCase(
  benchCase: BenchCaseV4,
  output: BenchRunOutput,
  thresholds: Thresholds,
  post: PostJson = defaultPostJson,
): Promise<ScoreCaseOutcome> {
  const outcomes: FieldScoreOutcome[] = []

  for (const scorer of Object.values(benchCase.fieldScorers)) {
    let fr: { outcome: FieldScoreOutcome; rateLimited: boolean }
    if (scorer === 'structured-diff') {
      fr = scoreStructuredField(benchCase, output)
    } else if (scorer === 'reference-judge') {
      fr = await scoreReferenceField(benchCase, output, post)
    } else if (scorer === 'faithfulness') {
      fr = await scoreFaithfulnessField(output, post)
    } else {
      fr = {
        outcome: { field: 'prose', scorer, score: null, skipped: true },
        rateLimited: false,
      }
    }
    outcomes.push(fr.outcome)
    // A throttled judge field aborts the row — the run stops before recording it.
    if (fr.rateLimited) return { row: null, rateLimited: true }
  }

  return { row: scoreRow(benchCase.id, outcomes, thresholds), rateLimited: false }
}
