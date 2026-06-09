export const runtime = 'nodejs'
export const maxDuration = 60

import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { checkRateLimit } from '@/lib/ratelimit'
import { bookSpend, SpendCapError } from '@/lib/killswitch'
import { scoreReferenceJudge, loadThresholds } from '@/lib/eval/index'
import type { ReferenceJudgeResult } from '@/lib/eval/index'
import { withClient } from '@/lib/db/index'
import { estimateTokens, assertWithinTokenLimit, MAX_INPUT_TOKENS, TokenLimitError } from '@/lib/tokens'

// Single judge call (verdict): ~4k input + ~1k output @ Haiku pricing.
const REFERENCE_JUDGE_ESTIMATE_MICRO_USD = Math.ceil(4_000 * 0.8 + 1_000 * 4.0) // 7_200 µ$

// Per-call output token cap (S17). One verdict block — small bounded output.
const REFERENCE_JUDGE_MAX_TOKENS = 1_024

// Haiku 4-5 pricing (USD per token) — used for trace cost estimation.
const JUDGE_MODEL = 'claude-haiku-4-5-20251001'
const INPUT_COST_PER_TOKEN = 0.8 / 1_000_000 // $0.80/1M input tokens
const OUTPUT_COST_PER_TOKEN = 4.0 / 1_000_000 // $4.00/1M output tokens

// ── Request shape ────────────────────────────────────────────────────────────
// Unlike /api/score (faithfulness-hardwired, grounding-based, no `expected`),
// this route carries an `expected` reference and scores `actual` against it.

interface ScoreReferenceRequest {
  /** The model output to score. */
  actual: string
  /** The hand-authored expected reference to compare against (in meaning). */
  expected: string
  /** Optional caller-supplied equivalence criteria (text never persisted). */
  criteria?: string
}

// ── Response shape ───────────────────────────────────────────────────────────

interface ScoreReferenceResponse {
  score: number | null
  verdict: ReferenceJudgeResult['verdict']
  reason: string | null
  /** Acceptance threshold read from config (never hardcoded). */
  threshold: number
  /** score >= threshold; null when the judge errored (no fabricated pass/fail). */
  passed: boolean | null
  errored?: boolean
  errorMessage?: string
  criteriaMeta?: string
}

// ── Trace shape (persisted to traces table) ──────────────────────────────────
// The judge prompt embeds `expected` + `actual`. Only the REDACTED prompt is
// persisted; expected/actual/criteria appear as sha256+len markers, never raw.

interface ScoreReferenceTrace {
  caseId: string
  /** Redacted prompt — EXPECTED/ACTUAL/criteria replaced with markers. */
  judgePrompt: string
  judgeModel: string
  isByo: boolean
  verdict: ReferenceJudgeResult['verdict']
  score: number | null
  threshold: number
  passed: boolean | null
  errored: boolean
  tokens: {
    /** Char/4 estimate — SDK per-call usage is not surfaced by the scorer return. */
    promptInputEst: number
    outputEst: number
    estCostUsd: number
  }
  /** Present when caller-supplied criteria was used; sha256+len marker, never raw text. */
  criteriaMeta?: string
}

// ── Abort helper ─────────────────────────────────────────────────────────────
// Races the given promise against the request AbortSignal. When the signal fires
// (client disconnect) the race rejects with AbortError, which falls into the
// outer catch block and triggers refundSpend().
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException('Request aborted', 'AbortError'))
        return
      }
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Request aborted', 'AbortError')),
        { once: true },
      )
    }),
  ])
}

// ── Validation ─────────────────────────────────────────────────────────────────

function validateBody(
  body: Record<string, unknown>,
): { parsed: ScoreReferenceRequest } | { error: string; status: number } {
  const actual = body.actual
  if (typeof actual !== 'string' || !actual) {
    return { error: 'actual is required (non-empty string)', status: 400 }
  }
  const expected = body.expected
  if (typeof expected !== 'string' || !expected) {
    return { error: 'expected is required (non-empty string)', status: 400 }
  }
  const criteria = typeof body.criteria === 'string' ? body.criteria : undefined
  return { parsed: { actual, expected, criteria } }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  // ── 0. Rate limit — shared per-IP bucket with /api/run, /api/retrieve, /api/score
  let rlResult: { ok: boolean; headers: Record<string, string> }
  try {
    rlResult = await checkRateLimit(req)
  } catch {
    return Response.json({ error: 'Service temporarily unavailable.' }, { status: 503 })
  }
  if (!rlResult.ok) {
    return Response.json(
      { error: 'Rate limit exceeded. Max 10 requests per hour per IP.' },
      { status: 429, headers: rlResult.headers },
    )
  }

  // ── 1. Parse + validate ───────────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const validation = validateBody(body)
  if ('error' in validation) {
    return Response.json({ error: validation.error }, { status: validation.status })
  }
  const parsedReq = validation.parsed

  // ── 2. BYO key — never logged or persisted ────────────────────────────────
  const byoKey = req.headers.get('x-byo-api-key') ?? undefined
  const envKey = process.env.ANTHROPIC_API_KEY
  const isByo = Boolean(byoKey)

  const judgeKey = byoKey ?? envKey
  if (!judgeKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is required' }, { status: 503 })
  }

  // ── 3. Book free-tier spend — BYO callers are spend-cap-exempt ────────────
  let refundSpend: (() => Promise<void>) | null = null
  if (!isByo) {
    try {
      refundSpend = await bookSpend(REFERENCE_JUDGE_ESTIMATE_MICRO_USD)
    } catch (err) {
      if (err instanceof SpendCapError) {
        return Response.json(
          {
            error:
              'Free-tier usage limit reached. Provide your own Anthropic API key to continue.',
          },
          { status: 429 },
        )
      }
      return Response.json({ error: 'Service temporarily unavailable.' }, { status: 503 })
    }
  }

  // ── 4. Score (single judge call, strict {verdict, reason}) ─────────────────
  const caseId = `score-ref-${crypto.randomUUID().slice(0, 8)}`
  let result: ReferenceJudgeResult
  try {
    const judgeClient = new Anthropic({ apiKey: judgeKey })

    // ── 4a. Input size guard (S17) ───────────────────────────────────────────
    // Reject oversized inputs before the judge call so actual spend stays within
    // the booked estimate. Applies to BYO and free-tier alike — a huge input
    // blows the real token cap regardless of spend-cap status. The combined
    // string mirrors what the prompt embeds (expected + actual + criteria).
    const combinedInput = [parsedReq.actual, parsedReq.expected, parsedReq.criteria ?? ''].join('\n')
    await assertWithinTokenLimit(combinedInput, judgeClient)

    result = await abortable(
      scoreReferenceJudge(parsedReq.actual, parsedReq.expected, judgeClient, {
        criteria: parsedReq.criteria,
        maxTokens: REFERENCE_JUDGE_MAX_TOKENS,
      }),
      req.signal,
    )
  } catch (e) {
    // Abort or unexpected error before scoring completes: refund booked spend.
    if (refundSpend) {
      await refundSpend()
      refundSpend = null
    }
    if (e instanceof TokenLimitError) {
      return Response.json(
        {
          error: `Input exceeds ${MAX_INPUT_TOKENS}-token limit (${e.tokenCount} tokens). Reduce expected or actual size.`,
        },
        { status: 413 },
      )
    }
    const msg = e instanceof Error ? e.message : 'An unexpected error occurred.'
    return Response.json({ error: msg }, { status: 503 })
  }

  // Scoring completed — spend is consumed (a swallowed judge error still costs;
  // it surfaces as errored:true, never a fabricated verdict). Build response.

  // ── 5. Threshold gate (read from config, never hardcoded) ──────────────────
  let threshold: number
  try {
    threshold = loadThresholds().referenceJudge
  } catch {
    threshold = 0.8 // config unreadable — fall back to the documented default
  }
  const passed = result.score == null ? null : result.score >= threshold

  const response: ScoreReferenceResponse = {
    score: result.score,
    verdict: result.verdict,
    reason: result.reason,
    threshold,
    passed,
    ...(result.errored ? { errored: true, errorMessage: result.errorMessage } : {}),
    ...(result.criteriaMeta ? { criteriaMeta: result.criteriaMeta } : {}),
  }

  // ── 6. Persist trace (best-effort, non-fatal) ──────────────────────────────
  // Only the redacted prompt is stored — expected/actual/criteria are sha256+len
  // markers, so no raw eval-input text reaches the trace store.
  try {
    const promptInputEst = estimateTokens(result.judgePrompt)
    const outputEst = estimateTokens(result.reason ?? '')
    const estCostUsd = promptInputEst * INPUT_COST_PER_TOKEN + outputEst * OUTPUT_COST_PER_TOKEN

    const trace: ScoreReferenceTrace = {
      caseId,
      judgePrompt: result.judgePrompt,
      judgeModel: JUDGE_MODEL,
      isByo,
      verdict: result.verdict,
      score: result.score,
      threshold,
      passed,
      errored: result.errored ?? false,
      tokens: { promptInputEst, outputEst, estCostUsd },
      ...(result.criteriaMeta ? { criteriaMeta: result.criteriaMeta } : {}),
    }

    await withClient(async (client) => {
      await client.query('INSERT INTO traces (trace) VALUES ($1)', [JSON.stringify(trace)])
    })
  } catch {
    // Non-fatal: scoring completed, response is correct. Log nothing (no PHI in stack traces).
  }

  return Response.json(response, { status: 200, headers: rlResult.headers })
}
