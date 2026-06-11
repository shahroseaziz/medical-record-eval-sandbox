export const runtime = 'nodejs'
export const maxDuration = 120

import { createHash } from 'crypto'
import { NextRequest } from 'next/server'
import { createDataStreamResponse, streamText, type JSONValue } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import Anthropic from '@anthropic-ai/sdk'
import { retrieve, fitChunksToBudget } from '@/lib/rag/index'
import type { RetrievedChunk } from '@/lib/rag/index'
import { buildPrompt, buildPromptParts, buildGroundingContext } from '@/lib/run/prompt'
import { scoreFaithfulness, scoreSectionHit } from '@/lib/eval/index'
import type { EvalCase } from '@/lib/eval/index'
import { withClient } from '@/lib/db/index'
import { estimateTokens, estimateInputTokens, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from '@/lib/tokens'
import { MODEL as EMBEDDING_MODEL } from '@/lib/voyage'
import { checkRateLimit } from '@/lib/ratelimit'
import { bookSpend, SpendCapError } from '@/lib/killswitch'
import { resolveJudgeKey } from './judge-key'
import { makeStopReasonCapture, classifyGenerationOutcome } from './stop-reason'
import { assembleRunTrace } from './trace'
import type { RunRequest } from './types'

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
  // The BYO key (caller's own Anthropic key, via header) decides whether this run
  // draws the shared $5 spend cap. Read it FIRST: it governs how an Upstash outage
  // is handled at the rate-limit gate below. Used in-flight only, never persisted.
  const byoKey = req.headers.get('x-byo-api-key') ?? undefined
  const isByo = Boolean(byoKey)

  // ── 0. Rate limit (shared bucket across all routes, per client IP) ──────
  // Fail-closed posture (arch S9a): an Upstash outage must never fail OPEN into
  // uncapped SHARED spend. For a free-tier run (which would book the $5 cap) we
  // reject (503). A BYO run books no shared spend — it bills the caller's own key
  // — so per S9a "BYO survive": an Upstash outage does not take the BYO path down.
  // A live limiter returning !ok is a genuine 429 and applies to everyone.
  let rlResult: { ok: boolean; headers: Record<string, string> }
  try {
    rlResult = await checkRateLimit(req)
  } catch {
    if (!isByo) {
      return Response.json(
        { error: 'Service temporarily unavailable.' },
        { status: 503 },
      )
    }
    // BYO survives a limiter outage — no shared spend at risk.
    rlResult = { ok: true, headers: {} }
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

  // BYO key was read at the top of the handler (it governs the fail-closed gate).
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
  // applies). isByo was computed at the top of the handler.
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
  // Split form: the static contextPrefix (system + record/chunk context) is the
  // cacheable prefix (D8), the questionSuffix is the only varying part. The
  // combined userTurnPrompt is byte-identical to the legacy single-string form,
  // so token counting and the persisted trace are unchanged.
  const groundingContext = buildGroundingContext(mode, chunks, record)
  const { systemPrompt, contextPrefix, questionSuffix, isUserAuthored } = buildPromptParts(
    query,
    groundingContext,
    generationPrompt,
  )
  const userTurnPrompt = `${contextPrefix}${questionSuffix}`
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
        // Prompt caching (D8): mark the static context block with Anthropic
        // `cache_control: ephemeral`. cache_control caches everything up to and
        // including its block — system prompt + the record/chunk context — so a
        // regeneration of the same case inside the ~5-min TTL re-reads the ~12k
        // shared prefix from cache (~0.1× input price) instead of re-billing it.
        // Only the QUESTION suffix (a separate, uncached text part) varies. Judge
        // calls stay uncached this cycle (arch S23).
        const result = streamText({
          model: aiProvider(model),
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: contextPrefix,
                  providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
                },
                { type: 'text', text: questionSuffix },
              ],
            },
          ],
          maxTokens: MAX_OUTPUT_TOKENS,
        })

        result.mergeIntoDataStream(dataStream)

        // ── 8. Collect full output + usage ────────────────────────────────
        const [output, usage, finishReason, providerMetadata] = await Promise.all([
          result.text,
          result.usage,
          result.finishReason,
          result.providerMetadata,
        ])
        // Prompt-cache accounting (D8): the Anthropic provider surfaces cache token
        // counts in providerMetadata.anthropic. cacheReadInputTokens > 0 is a warm
        // hit (prefix served from cache); cacheCreationInputTokens > 0 is a cold
        // write. Default to 0 when the provider reports no cache activity.
        const anthropicMeta = (providerMetadata?.anthropic ?? {}) as {
          cacheReadInputTokens?: number | null
          cacheCreationInputTokens?: number | null
        }
        const cacheReadTokens = Number(anthropicMeta.cacheReadInputTokens ?? 0)
        const cacheWriteTokens = Number(anthropicMeta.cacheCreationInputTokens ?? 0)
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
        //     usable output falls back to generic copy.
        //
        //     App-fault refund (E29d/S23): this terminated abnormally and is never
        //     scored/persisted, so any booked spend is refunded — the same fault
        //     class as the pre-call token-limit guards (5a/5b/5c). On the metered
        //     path the 12k ceiling (5b) precludes the context-overflow surface, so
        //     refundSpend is null here (BYO) and the refund is a no-op; wiring it
        //     keeps the invariant "every app-fault refunds" true regardless of
        //     which path reaches it. A genuine 429 never reaches this point (it is
        //     rejected at booking, before generation), so it never refunds.
        const outcome = classifyGenerationOutcome({
          rawStopReason: stopCapture.stopReason(),
          finishReason: String(finishReason),
          output,
        })
        if (!outcome.ok) {
          if (refundSpend) { await refundSpend(); refundSpend = null }
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
        // Prompt-cache pricing (D8): cache READS bill at ~0.1× input, cache WRITES
        // at ~1.25× input. usage.promptTokens already excludes cached reads (only
        // the freshly-processed input is counted there), so add the cache legs at
        // their own multipliers for a faithful cost estimate.
        const estCostUsd =
          usage.promptTokens * INPUT_COST_PER_TOKEN +
          usage.completionTokens * OUTPUT_COST_PER_TOKEN +
          cacheReadTokens * INPUT_COST_PER_TOKEN * 0.1 +
          cacheWriteTokens * INPUT_COST_PER_TOKEN * 1.25 +
          embeddingTokens * EMBED_COST_PER_TOKEN

        const assembledPromptForTrace = isUserAuthored
          ? redactForTrace(fullAssembledPrompt)
          : fullAssembledPrompt

        const trace = assembleRunTrace({
          caseId,
          mode,
          groundingContext,
          isUserAuthored,
          assembledPromptForTrace,
          chunks,
          retrievedCount,
          inBudgetCount,
          sectionHit: sectionHitResult,
          faithfulness: faithfulnessResult,
          output,
          generationModel: model,
          judgeModel,
          embeddingModel: mode === 'retrieve' ? EMBEDDING_MODEL : 'none',
          tokens: {
            input: usage.promptTokens,
            output: usage.completionTokens,
            estCostUsd,
            cacheReadTokens,
            cacheWriteTokens,
          },
          judgeUsesByo: judgeKeyIsByo,
        })

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
