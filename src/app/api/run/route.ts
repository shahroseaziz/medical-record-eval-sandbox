export const runtime = 'nodejs'
export const maxDuration = 120

import { createHash } from 'crypto'
import { NextRequest } from 'next/server'
import { createDataStreamResponse, streamText, type JSONValue } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import Anthropic from '@anthropic-ai/sdk'
import { retrieve, fitChunksToBudget } from '@/lib/rag/index'
import type { RetrievedChunk } from '@/lib/rag/index'
import { buildPrompt, buildGroundingContext } from '@/lib/run/prompt'
import { scoreFaithfulness, scoreSectionHit } from '@/lib/eval/index'
import type { EvalCase } from '@/lib/eval/index'
import { withClient } from '@/lib/db/index'
import { estimateTokens, estimateInputTokens, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from '@/lib/tokens'
import { MODEL as EMBEDDING_MODEL } from '@/lib/voyage'
import { checkRateLimit } from '@/lib/ratelimit'
import { bookSpend, SpendCapError } from '@/lib/killswitch'
import { resolveJudgeKey } from './judge-key'
import { makeStopReasonCapture, classifyGenerationOutcome } from './stop-reason'
import type { RunTrace, RunRequest } from './types'

const DEFAULT_GENERATION_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001'

// Haiku 4-5 has a 200k context window; reserve 10k for safety
const MODEL_CONTEXT_LIMIT = 190_000

// Approximate pricing (USD per token)
const INPUT_COST_PER_TOKEN = 0.8 / 1_000_000   // $0.80/1M input tokens
const OUTPUT_COST_PER_TOKEN = 4.0 / 1_000_000   // $4.00/1M output tokens
const EMBED_COST_PER_TOKEN = 0.02 / 1_000_000   // Voyage-3.5 $0.02/1M tokens

// When the caller supplies a custom generation prompt, store a hash+length in the
// trace rather than the text itself (privacy rule: user-authored prompt text must
// never be persisted).
function redactForTrace(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex')
  return `[REDACTED sha256=${hash} length=${text.length}]`
}

// Context-overflow is an APP-FAULT class, not a 4xx-only signal. Classify ALL
// three surfaces (SHA-78 / arch S25) — never assume an HTTP 400:
//   • 413 request_too_large  — oversized payload rejected by the API
//   • HTTP 200 + stop_reason "model_context_window_exceeded" — Claude 4.5+ returns
//     this on a *successful* response, so it can arrive via finishReason/metadata
//     rather than a thrown error
//   • legacy 400 "prompt is too long" / "context window" phrasings
function isOverContextError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  const status = error instanceof Anthropic.APIError ? error.status : undefined
  return (
    status === 413 ||
    msg.includes('request_too_large') ||
    msg.includes('model_context_window_exceeded') ||
    msg.includes('prompt is too long') ||
    msg.includes('context window') ||
    msg.includes('too many tokens') ||
    msg.includes('Input is too long') ||
    (status === 400 && msg.includes('token'))
  )
}

// Remediation copy that NEVER advises the caller's CURRENT mode (arch S25:
// "Error copy never advises the current mode"). Switching to retrieve mode is
// only useful advice when you are NOT already in retrieve mode.
function overBudgetAdvice(mode: 'retrieve' | 'stuff'): string {
  return mode === 'stuff'
    ? 'Reduce the record size, or switch to retrieve mode to send only the most relevant sections.'
    : 'Use a more focused query, or lower k to retrieve fewer sections.'
}

export async function POST(req: NextRequest): Promise<Response> {
  // ── 0. Rate limit (shared bucket across all routes, per client IP) ──────
  // Fail closed: if Upstash is unreachable, reject rather than allow traffic.
  let rlResult: { ok: boolean; headers: Record<string, string> }
  try {
    rlResult = await checkRateLimit(req)
  } catch {
    return Response.json(
      { error: 'Service temporarily unavailable.' },
      { status: 503 },
    )
  }
  if (!rlResult.ok) {
    return Response.json(
      { error: 'Rate limit exceeded. Max 10 requests per hour per IP.' },
      { status: 429, headers: rlResult.headers },
    )
  }

  // ── 1. Parse + validate request ──────────────────────────────────────────
  let body: Partial<RunRequest>
  try {
    body = (await req.json()) as Partial<RunRequest>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const {
    patientId,
    query,
    mode,
    record,
    k = 6,
    model = DEFAULT_GENERATION_MODEL,
    judgeModel = DEFAULT_JUDGE_MODEL,
    judgeUsesByo = false,
    generationPrompt,
    generateOnly = false,
  } = body

  if (!patientId || !query) {
    return Response.json({ error: 'patientId and query are required' }, { status: 400 })
  }
  if (mode !== 'retrieve' && mode !== 'stuff') {
    return Response.json({ error: 'mode must be "retrieve" or "stuff"' }, { status: 400 })
  }
  if (mode === 'stuff' && !record) {
    return Response.json({ error: 'record is required in stuff mode' }, { status: 400 })
  }
  if (mode === 'retrieve' && !process.env.VOYAGE_API_KEY) {
    return Response.json(
      { error: 'VOYAGE_API_KEY is required for retrieve mode' },
      { status: 503 },
    )
  }

  // BYO key comes from a request header, never from the request body.
  // It is used in-flight only and is never logged or persisted.
  const byoKey = req.headers.get('x-byo-api-key') ?? undefined
  const envKey = process.env.ANTHROPIC_API_KEY

  // Generation always uses the BYO key when provided; falls back to env.
  const generationKey = byoKey ?? envKey
  if (!generationKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is required' }, { status: 503 })
  }

  // Judge uses the seeded env key by default so scores stay comparable to the baseline.
  // If judgeUsesByo is true the judge uses the caller's key (scores are non-comparable).
  // If no env key exists, fall back to the BYO key regardless (only available option).
  // resolveJudgeKey derives judgeKeyIsByo from the ACTUAL key used, not from the
  // requested flag — important when envKey is absent and the judge silently falls back.
  const { judgeKey, judgeKeyIsByo } = resolveJudgeKey(byoKey, envKey, judgeUsesByo ?? false)
  if (!judgeKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is required' }, { status: 503 })
  }

  const judgeClient = new Anthropic({ apiKey: judgeKey })
  // Tee the generation provider's raw SSE so we can read the provider's verbatim
  // stop_reason (model_context_window_exceeded etc.) rather than the SDK's lossy,
  // version-dependent finishReason mapping. See ./stop-reason.
  const stopCapture = makeStopReasonCapture()
  const aiProvider = createAnthropic({ apiKey: generationKey, fetch: stopCapture.fetch })
  const caseId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`

  // BYO callers bypass the 12k free-tier ceiling (only the model-context guard
  // applies); used both by the budget below and the spend-cap gating later.
  const isByo = Boolean(byoKey)
  // Input budget for assembly: the 12k metered ceiling for free-tier callers,
  // the model context window for BYO (their key, their budget).
  const inputBudget = isByo ? MODEL_CONTEXT_LIMIT : MAX_INPUT_TOKENS

  // ── 2. Retrieval + budget-bounded assembly (retrieve mode only) ──────────
  // SHA-75 fix: assembly bounds by TOKEN COUNT, not k alone. retrieve() returns
  // up to k chunks; we append them in relevance order until the input budget is
  // reached, then stop. Partial sets are valid; the Inspector reports
  // "X retrieved · Y fit budget" from these counts.
  let chunks: RetrievedChunk[] = []
  let retrievedCount = 0
  let inBudgetCount = 0
  if (mode === 'retrieve') {
    const retrieveResult = await retrieve(patientId, query, k)
    // Overhead = the prompt with NO grounding (system + query + scaffolding).
    const empty = buildPrompt(query, '', generationPrompt)
    const overheadTokens = estimateInputTokens(`${empty.systemPrompt}\n\n${empty.userTurnPrompt}`)
    const assembly = fitChunksToBudget(
      retrieveResult.chunks,
      inputBudget,
      overheadTokens,
      (cs) => buildGroundingContext('retrieve', cs),
    )
    chunks = assembly.chunks
    retrievedCount = assembly.retrievedCount
    inBudgetCount = assembly.inBudgetCount
  }

  // ── 3. Assemble prompt ───────────────────────────────────────────────────
  const groundingContext = buildGroundingContext(mode, chunks, record)
  const { systemPrompt, userTurnPrompt, isUserAuthored } = buildPrompt(query, groundingContext, generationPrompt)
  // Combined string used for token counting and (when default prompt) trace storage.
  const fullAssembledPrompt = `${systemPrompt}\n\n${userTurnPrompt}`

  // ── 4. Killswitch — book estimated spend (free-tier only) ────────────────
  // BYO callers (key provided via header) bypass Anthropic spend caps but still
  // share the rate-limit bucket above. Fail closed if Upstash is unreachable.
  // (isByo is computed above, alongside the input budget.)
  let refundSpend: (() => Promise<void>) | null = null
  if (!isByo) {
    try {
      refundSpend = await bookSpend()
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
      // Upstash unreachable → fail closed
      return Response.json(
        { error: 'Service temporarily unavailable.' },
        { status: 503 },
      )
    }
  }

  return createDataStreamResponse({
    execute: async (dataStream) => {
      try {
        // ── 5. Token-budget pre-checks (fail closed, no API round-trip) ────
        // SHA-78 / arch S25: counting is a LOCAL approximation with a safety
        // margin (estimateInputTokens) — no per-run count_tokens round-trip.
        // When the local approximation under-counts, this same 12k ceiling
        // still rejects the payload pre-call, so Anthropic is never reached
        // (a true-free, refunded app-fault on the metered path).

        // 5a. Retrieve mode: a patient whose single most-relevant section can't
        //     fit even one chunk surfaces a NAMED, non-circular error (never
        //     advises the current mode).
        if (mode === 'retrieve' && retrievedCount > 0 && inBudgetCount === 0) {
          if (refundSpend) { await refundSpend(); refundSpend = null }
          dataStream.writeData({
            type: 'error',
            message: `Patient ${patientId}: the most relevant retrieved section alone exceeds the ${inputBudget}-token input budget, so no context could be assembled. ${overBudgetAdvice('retrieve')}`,
          })
          return
        }

        // 5b. 12k free-tier ceiling (lifted for BYO — only the model-context
        //     guard below applies there).
        if (!isByo) {
          const inputCount = estimateInputTokens(fullAssembledPrompt)
          if (inputCount > MAX_INPUT_TOKENS) {
            if (refundSpend) { await refundSpend(); refundSpend = null }
            dataStream.writeData({
              type: 'error',
              message: `Assembled context exceeds the ${MAX_INPUT_TOKENS}-token limit (~${inputCount} tokens). ${overBudgetAdvice(mode)}`,
            })
            return
          }
        }

        // 5c. Model-context guard (applies to all callers, BYO included).
        const estimatedInputTokens = estimateInputTokens(fullAssembledPrompt)
        if (estimatedInputTokens > MODEL_CONTEXT_LIMIT) {
          if (refundSpend) { await refundSpend(); refundSpend = null }
          dataStream.writeData({
            type: 'error',
            message: `Assembled context (~${estimatedInputTokens} tokens) exceeds the model context limit (${MODEL_CONTEXT_LIMIT} tokens). ${overBudgetAdvice(mode)}`,
          })
          return
        }

        // ── 6. Stream retrieval metadata ──────────────────────────────────
        if (mode === 'retrieve') {
          dataStream.writeData({
            type: 'retrieval',
            chunks: chunks.map((c) => ({
              section: c.section,
              text: c.text,
              distance: c.distance,
              similarity: c.similarity,
            })),
            groundingContext,
            retrievedCount,
            inBudgetCount,
          })
        }

        // ── 7. Stream generation tokens ───────────────────────────────────
        const result = streamText({
          model: aiProvider(model),
          system: systemPrompt,
          prompt: userTurnPrompt,
          maxTokens: MAX_OUTPUT_TOKENS,
        })

        result.mergeIntoDataStream(dataStream)

        // ── 8. Collect full output + usage ────────────────────────────────
        const [output, usage, finishReason] = await Promise.all([
          result.text,
          result.usage,
          result.finishReason,
        ])
        // Wait for the raw-SSE scan to finish so the provider stop_reason is final.
        await stopCapture.done

        // 8a. HTTP-200 + stop_reason "model_context_window_exceeded" surface
        //     (Claude 4.5+): the request succeeds (no thrown error) but the model
        //     truncates because the context window was exceeded. We classify off
        //     the provider's VERBATIM stop_reason (read from the raw SSE), not the
        //     SDK's "unknown" finishReason proxy — so a run that emitted partial
        //     output before overflowing is still caught (never scored/persisted as
        //     complete), other unknown stop_reasons (refusal/pause) are not
        //     misclassified as context overflow, and a dep bump cannot silently
        //     break detection. An abnormal finish with no raw stop_reason and no
        //     usable output falls back to generic copy. Reachable only on the
        //     BYO/raised-budget path, so spend is the user's key — no cap refund.
        const outcome = classifyGenerationOutcome({
          rawStopReason: stopCapture.stopReason(),
          finishReason: String(finishReason),
          output,
        })
        if (!outcome.ok) {
          dataStream.writeData({
            type: 'error',
            message:
              outcome.kind === 'context_overflow'
                ? `Request exceeds the model context window. ${overBudgetAdvice(mode)}`
                : 'The model stopped unexpectedly without returning a usable answer. Please retry.',
          })
          return
        }

        // ── 9. Run scorers ────────────────────────────────────────────────
        const evalCase: EvalCase = {
          id: caseId,
          patientId,
          query,
          output,
          mode,
          retrievedChunks:
            mode === 'retrieve'
              ? chunks.map((c) => ({ section: c.section, text: c.text }))
              : undefined,
          record: mode === 'stuff' ? record : undefined,
          k: mode === 'retrieve' ? k : undefined,
        }

        // section-hit is deterministic (no model call), so it runs in both modes.
        // The faithfulness judge is an Anthropic call we skip in generate-only mode —
        // that's the whole point of the fan-out: re-generate over N cases without
        // paying for N judge calls. Scoring is a separate, deliberate step.
        const sectionHitResult = scoreSectionHit(evalCase)
        const faithfulnessResult = generateOnly
          ? null
          : await scoreFaithfulness(evalCase, judgeClient)

        // ── 10. Stream eval results (skipped in generate-only mode) ───────
        if (faithfulnessResult) {
          dataStream.writeData({
            type: 'eval',
            faithfulness: faithfulnessResult,
            sectionHit: sectionHitResult,
          } as unknown as JSONValue)
        }

        // ── 11. Persist trace to DB ───────────────────────────────────────
        const embeddingTokens = mode === 'retrieve' ? estimateTokens(query) : 0
        const estCostUsd =
          usage.promptTokens * INPUT_COST_PER_TOKEN +
          usage.completionTokens * OUTPUT_COST_PER_TOKEN +
          embeddingTokens * EMBED_COST_PER_TOKEN

        const assembledPromptForTrace = isUserAuthored
          ? redactForTrace(fullAssembledPrompt)
          : fullAssembledPrompt

        const trace: RunTrace = {
          caseId,
          ragMode: mode,
          grounding: groundingContext,
          generationPromptIsUserAuthored: isUserAuthored,
          retrieval:
            mode === 'retrieve'
              ? {
                  chunks: chunks.map((c) => ({
                    section: c.section,
                    text: c.text,
                    distance: c.distance,
                    similarity: c.similarity,
                  })),
                  groundingContext,
                  assembledPrompt: assembledPromptForTrace,
                  retrievedCount,
                  inBudgetCount,
                }
              : undefined,
          sectionHit: sectionHitResult,
          output,
          scorerResults: faithfulnessResult
            ? [faithfulnessResult, sectionHitResult]
            : [sectionHitResult],
          generationModel: model,
          judgeModel,
          embeddingModel: mode === 'retrieve' ? EMBEDDING_MODEL : 'none',
          inputType: 'query',
          tokens: {
            input: usage.promptTokens,
            output: usage.completionTokens,
            estCostUsd,
          },
          claimCount: faithfulnessResult ? faithfulnessResult.claims.length : 0,
          outputLength: output.length,
          judgeUsesByo: judgeKeyIsByo,
        }

        dataStream.writeData({ type: 'trace', trace } as unknown as JSONValue)

        await withClient(async (client) => {
          await client.query('INSERT INTO traces (trace) VALUES ($1)', [JSON.stringify(trace)])
        })
      } catch (e) {
        // Refund the booked spend if the request aborts or errors mid-flight.
        if (refundSpend) {
          await refundSpend()
          refundSpend = null
        }
        throw e
      }
    },

    onError: (error) => {
      // Convert Anthropic context-overflow surfaces (413 request_too_large, 200 +
      // model_context_window_exceeded, legacy 400) to a graceful, app-fault
      // message whose remediation never advises the caller's current mode.
      if (isOverContextError(error)) {
        return `Request exceeds the model context window. ${overBudgetAdvice(mode)}`
      }
      return error instanceof Error ? error.message : 'An unexpected error occurred.'
    },
  })
}
