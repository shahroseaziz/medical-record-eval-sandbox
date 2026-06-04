export const runtime = 'nodejs'
export const maxDuration = 60

import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { checkRateLimit } from '@/lib/ratelimit'
import { bookSpend, SpendCapError } from '@/lib/killswitch'
import { scoreFaithfulness } from '@/lib/eval/index'
import type { EvalCase, FaithfulnessResult } from '@/lib/eval/index'
import { retrieve } from '@/lib/rag/index'
import { withClient } from '@/lib/db/index'
import { estimateTokens } from '@/lib/tokens'

// 2 judge calls (extract + verdict): ~3.5k input + 1k output each @ Haiku pricing
const JUDGE_SCORE_ESTIMATE_MICRO_USD = Math.ceil(7_000 * 0.8 + 2_000 * 4.0) // 13_600 µ$

// Per-call output token caps for the two judge calls (scoring only, no generation).
// Extract produces a flat claim list; verdict produces one verdict block per claim.
const SCORE_EXTRACT_MAX_TOKENS = 1_024
const SCORE_VERDICT_MAX_TOKENS = 2_048

// Haiku 4-5 pricing (USD per token) — used for trace cost estimation.
const JUDGE_MODEL = 'claude-haiku-4-5-20251001'
const INPUT_COST_PER_TOKEN = 0.8 / 1_000_000   // $0.80/1M input tokens
const OUTPUT_COST_PER_TOKEN = 4.0 / 1_000_000   // $4.00/1M output tokens

// ── Request discriminated union ──────────────────────────────────────────────

interface ScoreCapturedRequest {
  source: 'captured'
  /** The model output to score. */
  capturedOutput: string
  /** The assembled grounding context the output was produced against (authoritative). */
  capturedGrounding: string
  /** Optional caller-supplied verdict rubric (text never persisted). */
  userVerdictRubric?: string
}

interface ScoreRefetchRequest {
  source: 'refetch'
  /** The model output to score. */
  capturedOutput: string
  /** Patient whose chunks will be re-retrieved. */
  patientId: string
  /** Whether to re-retrieve via vector search or use a raw record string. */
  ragMode: 'retrieve' | 'stuff'
  /** Required when ragMode === 'retrieve': the original query to re-run vector search. */
  query?: string
  /** Required when ragMode === 'stuff': the full record text. */
  record?: string
  /** Number of chunks to retrieve (retrieve mode only, default 6). */
  k?: number
  /** Optional caller-supplied verdict rubric (text never persisted). */
  userVerdictRubric?: string
}

type ScoreRequest = ScoreCapturedRequest | ScoreRefetchRequest

// ── Response shape ───────────────────────────────────────────────────────────

interface ClaimBreakdown {
  claim: string
  verdict: 'supported' | 'unsupported' | 'partial'
  reason: string
}

interface ScoreResponse {
  score: number | null
  errored?: boolean
  errorMessage?: string
  zeroClaimFlag?: boolean
  claims: ClaimBreakdown[]
  groundingSource: 'captured' | 'refetch'
  /** Present when grounding was re-fetched; warns that it may differ from the original capture. */
  groundingNote?: string
  verdictRubricMeta?: string
}

// ── Trace shape (persisted to traces table) ──────────────────────────────────

interface ScoreTrace {
  caseId: string
  groundingSource: 'captured' | 'refetch'
  groundingNote?: string
  /** Assembled grounding text used for scoring. */
  grounding: string
  /** The model output that was scored. */
  capturedOutput: string
  scorerResult: FaithfulnessResult
  judgeModel: string
  isByo: boolean
  tokens: {
    /** Char/4 estimate — actual usage unavailable from scorer return value. */
    extractInputEst: number
    extractOutputEst: number
    verdictInputEst: number
    verdictOutputEst: number
    estCostUsd: number
  }
  claimCount: number
  score: number | null
  errored: boolean
}

// ── Abort helper ─────────────────────────────────────────────────────────────

// Races the given promise against the request AbortSignal. When the signal
// fires (client disconnect) the race rejects with AbortError, which falls into
// the outer catch block and triggers refundSpend(). The underlying calls
// (retrieve / scoreFaithfulness) are not directly cancelled — they will
// settle on their own — but we stop waiting for them and refund immediately.
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

// ── Validation helpers ───────────────────────────────────────────────────────

function validateBody(body: Record<string, unknown>): { parsed: ScoreRequest } | { error: string; status: number } {
  const { source } = body

  if (source !== 'captured' && source !== 'refetch') {
    return { error: 'source must be "captured" or "refetch"', status: 400 }
  }

  const capturedOutput = body.capturedOutput
  if (typeof capturedOutput !== 'string' || !capturedOutput) {
    return { error: 'capturedOutput is required (non-empty string)', status: 400 }
  }

  const userVerdictRubric =
    typeof body.userVerdictRubric === 'string' ? body.userVerdictRubric : undefined

  if (source === 'captured') {
    const capturedGrounding = body.capturedGrounding
    if (typeof capturedGrounding !== 'string' || !capturedGrounding) {
      return { error: 'capturedGrounding is required (non-empty string)', status: 400 }
    }
    return {
      parsed: { source: 'captured', capturedOutput, capturedGrounding, userVerdictRubric },
    }
  }

  // source === 'refetch'
  const patientId = body.patientId
  if (typeof patientId !== 'string' || !patientId) {
    return { error: 'patientId is required for refetch source', status: 400 }
  }
  const ragMode = body.ragMode
  if (ragMode !== 'retrieve' && ragMode !== 'stuff') {
    return { error: 'ragMode must be "retrieve" or "stuff"', status: 400 }
  }
  if (ragMode === 'retrieve') {
    const query = body.query
    if (typeof query !== 'string' || !query) {
      return { error: 'query is required for refetch with ragMode "retrieve"', status: 400 }
    }
  }
  if (ragMode === 'stuff') {
    const record = body.record
    if (typeof record !== 'string' || !record) {
      return { error: 'record is required for refetch with ragMode "stuff"', status: 400 }
    }
  }
  return {
    parsed: {
      source: 'refetch',
      capturedOutput,
      patientId,
      ragMode,
      query: typeof body.query === 'string' ? body.query : undefined,
      record: typeof body.record === 'string' ? body.record : undefined,
      k: typeof body.k === 'number' ? body.k : undefined,
      userVerdictRubric,
    },
  }
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<Response> {
  // ── 0. Rate limit — shared bucket with /api/run and /api/retrieve ──────────
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

  // Refuse refetch/retrieve when VOYAGE_API_KEY is absent (config issue, safe to check early)
  if (
    parsedReq.source === 'refetch' &&
    parsedReq.ragMode === 'retrieve' &&
    !process.env.VOYAGE_API_KEY
  ) {
    return Response.json(
      { error: 'VOYAGE_API_KEY is required for refetch with ragMode "retrieve"' },
      { status: 503 },
    )
  }

  // ── 2. BYO key — never logged or persisted ────────────────────────────────
  const byoKey = req.headers.get('x-byo-api-key') ?? undefined
  const envKey = process.env.ANTHROPIC_API_KEY
  const isByo = Boolean(byoKey)

  const judgeKey = byoKey ?? envKey
  if (!judgeKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is required' }, { status: 503 })
  }

  // ── 3. Book free-tier spend — BYO callers are spend-cap-exempt ────────────
  // Capture the refund closure so it can be called on abort or error.
  let refundSpend: (() => Promise<void>) | null = null
  if (!isByo) {
    try {
      refundSpend = await bookSpend(JUDGE_SCORE_ESTIMATE_MICRO_USD)
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

  // ── 4. Build EvalCase + score ─────────────────────────────────────────────
  // abortable() races each async step against req.signal so that a client
  // disconnect causes the catch block to run and refundSpend() to be called.
  let evalCase: EvalCase
  let groundingSource: 'captured' | 'refetch'
  let groundingNote: string | undefined
  let groundingText: string
  let faithfulnessResult: FaithfulnessResult

  try {
    if (parsedReq.source === 'captured') {
      groundingSource = 'captured'
      groundingText = parsedReq.capturedGrounding
      // Treat the assembled grounding string as a "record" in stuff mode so
      // getGrounding() in the scorer returns it verbatim as the sole truth source.
      evalCase = {
        id: `score-${crypto.randomUUID().slice(0, 8)}`,
        patientId: '(score-request)',
        query: '',
        output: parsedReq.capturedOutput,
        mode: 'stuff',
        record: parsedReq.capturedGrounding,
      }
    } else {
      // source === 'refetch'
      groundingSource = 'refetch'
      groundingNote = 'grounding re-fetched, may differ from capture'

      if (parsedReq.ragMode === 'retrieve') {
        const retrieveResult = await abortable(
          retrieve(parsedReq.patientId, parsedReq.query!, parsedReq.k ?? 6),
          req.signal,
        )
        groundingText = retrieveResult.chunks
          .map((c) => `[${c.section}]\n${c.text}`)
          .join('\n\n---\n\n')
        evalCase = {
          id: `score-${crypto.randomUUID().slice(0, 8)}`,
          patientId: parsedReq.patientId,
          query: parsedReq.query!,
          output: parsedReq.capturedOutput,
          mode: 'retrieve',
          retrievedChunks: retrieveResult.chunks.map((c) => ({
            section: c.section,
            text: c.text,
          })),
          k: parsedReq.k ?? 6,
        }
      } else {
        groundingText = parsedReq.record!
        evalCase = {
          id: `score-${crypto.randomUUID().slice(0, 8)}`,
          patientId: parsedReq.patientId,
          query: '',
          output: parsedReq.capturedOutput,
          mode: 'stuff',
          record: parsedReq.record!,
        }
      }
    }

    // ── 5. Score (fixed extraction → user-rubric verdict) ─────────────────
    // No generation call. Per-call output token caps guard both judge calls.
    const judgeClient = new Anthropic({ apiKey: judgeKey })
    faithfulnessResult = await abortable(
      scoreFaithfulness(evalCase, judgeClient, parsedReq.userVerdictRubric, {
        extractMaxTokens: SCORE_EXTRACT_MAX_TOKENS,
        verdictMaxTokens: SCORE_VERDICT_MAX_TOKENS,
      }),
      req.signal,
    )
  } catch (e) {
    // Abort or error before scoring completes: refund the booked spend.
    if (refundSpend) {
      await refundSpend()
      refundSpend = null
    }
    const msg = e instanceof Error ? e.message : 'An unexpected error occurred.'
    return Response.json({ error: msg }, { status: 503 })
  }

  // Scoring completed — spend is consumed (no refund). Build response.

  // ── 6. Build response ─────────────────────────────────────────────────────
  const claims: ClaimBreakdown[] = faithfulnessResult.claims.map((c) => ({
    claim: c.claim,
    verdict: c.verdict,
    reason: c.rationale,
  }))

  const scoreResponse: ScoreResponse = {
    score: faithfulnessResult.score,
    ...(faithfulnessResult.errored
      ? { errored: true, errorMessage: faithfulnessResult.errorMessage }
      : {}),
    ...(faithfulnessResult.zeroClaimFlag ? { zeroClaimFlag: true } : {}),
    claims,
    groundingSource,
    ...(groundingNote ? { groundingNote } : {}),
    ...(faithfulnessResult.verdictRubricMeta
      ? { verdictRubricMeta: faithfulnessResult.verdictRubricMeta }
      : {}),
  }

  // ── 7. Persist trace (best-effort, non-fatal) ─────────────────────────────
  // Token counts are char/4 estimates — scoreFaithfulness does not expose
  // per-call usage from the SDK response, so we estimate from prompt lengths.
  try {
    const extractInputEst = estimateTokens(faithfulnessResult.extractPrompt)
    const claimText = faithfulnessResult.claims.map((c) => c.claim).join(' ')
    const extractOutputEst = estimateTokens(claimText)
    const verdictInputEst = estimateTokens(faithfulnessResult.verdictPrompt)
    const verdictText = faithfulnessResult.claims
      .map((c) => `${c.verdict} ${c.rationale}`)
      .join(' ')
    const verdictOutputEst = estimateTokens(verdictText)
    const estCostUsd =
      (extractInputEst + verdictInputEst) * INPUT_COST_PER_TOKEN +
      (extractOutputEst + verdictOutputEst) * OUTPUT_COST_PER_TOKEN

    const trace: ScoreTrace = {
      caseId: evalCase.id,
      groundingSource,
      ...(groundingNote ? { groundingNote } : {}),
      grounding: groundingText,
      capturedOutput: parsedReq.capturedOutput,
      scorerResult: faithfulnessResult,
      judgeModel: JUDGE_MODEL,
      isByo,
      tokens: {
        extractInputEst,
        extractOutputEst,
        verdictInputEst,
        verdictOutputEst,
        estCostUsd,
      },
      claimCount: faithfulnessResult.claims.length,
      score: faithfulnessResult.score,
      errored: faithfulnessResult.errored ?? false,
    }

    await withClient(async (client) => {
      await client.query('INSERT INTO traces (trace) VALUES ($1)', [JSON.stringify(trace)])
    })
  } catch {
    // Non-fatal: scoring completed, response is correct. Log nothing (no PHI in stack traces).
  }

  return Response.json(scoreResponse, { status: 200, headers: rlResult.headers })
}
