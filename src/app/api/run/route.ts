export const runtime = 'nodejs'
export const maxDuration = 120

import { createHash } from 'crypto'
import { NextRequest } from 'next/server'
import { createDataStreamResponse, streamText, type JSONValue } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import Anthropic from '@anthropic-ai/sdk'
import { retrieve } from '@/lib/rag/index'
import type { RetrievedChunk } from '@/lib/rag/index'
import { scoreFaithfulness, scoreSectionHit } from '@/lib/eval/index'
import type { EvalCase } from '@/lib/eval/index'
import { withClient } from '@/lib/db/index'
import { estimateTokens, countInputTokens, MAX_INPUT_TOKENS, MAX_OUTPUT_TOKENS } from '@/lib/tokens'
import { MODEL as EMBEDDING_MODEL } from '@/lib/voyage'
import { checkRateLimit } from '@/lib/ratelimit'
import { bookSpend, SpendCapError } from '@/lib/killswitch'
import type { RunTrace, RunRequest } from './types'

const DEFAULT_GENERATION_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001'

// Haiku 4-5 has a 200k context window; reserve 10k for safety
const MODEL_CONTEXT_LIMIT = 190_000

// Approximate pricing (USD per token)
const INPUT_COST_PER_TOKEN = 0.8 / 1_000_000   // $0.80/1M input tokens
const OUTPUT_COST_PER_TOKEN = 4.0 / 1_000_000   // $4.00/1M output tokens
const EMBED_COST_PER_TOKEN = 0.02 / 1_000_000   // Voyage-3.5 $0.02/1M tokens

function buildGroundingContext(
  mode: 'retrieve' | 'stuff',
  chunks: RetrievedChunk[],
  record?: string
): string {
  if (mode === 'retrieve') {
    if (chunks.length === 0) return '(no retrieved context available)'
    return chunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
  }
  return record ?? '(no record provided)'
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a medical record analyst. Answer the question based ONLY on the provided medical record context. Do not use outside knowledge or make assumptions beyond what is stated.'

function buildPrompt(
  query: string,
  groundingContext: string,
  generationPrompt?: string,
): { systemPrompt: string; userTurnPrompt: string; isUserAuthored: boolean } {
  return {
    systemPrompt: generationPrompt ?? DEFAULT_SYSTEM_PROMPT,
    userTurnPrompt: `MEDICAL RECORD CONTEXT:\n${groundingContext}\n\nQUESTION:\n${query}\n\nProvide a thorough, accurate answer based solely on the information in the medical record context above. If the context does not contain sufficient information to answer the question, say so explicitly.`,
    isUserAuthored: Boolean(generationPrompt),
  }
}

// When the caller supplies a custom generation prompt, store a hash+length in the
// trace rather than the text itself (privacy rule: user-authored prompt text must
// never be persisted).
function redactForTrace(text: string): string {
  const hash = createHash('sha256').update(text).digest('hex')
  return `[REDACTED sha256=${hash} length=${text.length}]`
}

function isOverContextError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    msg.includes('prompt is too long') ||
    msg.includes('context window') ||
    msg.includes('too many tokens') ||
    msg.includes('Input is too long') ||
    (error instanceof Anthropic.APIError && error.status === 400 && msg.includes('token'))
  )
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
  const effectiveJudgeUsesByo = Boolean(judgeUsesByo && byoKey)
  const judgeKey = effectiveJudgeUsesByo ? byoKey! : (envKey ?? byoKey!)
  if (!judgeKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is required' }, { status: 503 })
  }
  // Derive the stored flag from the actual key used, not from the requested flag.
  // When envKey is absent the fallback to byoKey is invisible to effectiveJudgeUsesByo,
  // causing the stored flag to misreport false even though the BYO key was used.
  const judgeKeyIsByo = Boolean(byoKey && judgeKey === byoKey)

  const judgeClient = new Anthropic({ apiKey: judgeKey })
  const aiProvider = createAnthropic({ apiKey: generationKey })
  const caseId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`

  // ── 2. Retrieval (retrieve mode only) ────────────────────────────────────
  let chunks: RetrievedChunk[] = []
  if (mode === 'retrieve') {
    const retrieveResult = await retrieve(patientId, query, k)
    chunks = retrieveResult.chunks
  }

  // ── 3. Assemble prompt ───────────────────────────────────────────────────
  const groundingContext = buildGroundingContext(mode, chunks, record)
  const { systemPrompt, userTurnPrompt, isUserAuthored } = buildPrompt(query, groundingContext, generationPrompt)
  // Combined string used for token counting and (when default prompt) trace storage.
  const fullAssembledPrompt = `${systemPrompt}\n\n${userTurnPrompt}`

  // ── 4. Killswitch — book estimated spend (free-tier only) ────────────────
  // BYO callers (key provided via header) bypass Anthropic spend caps but still
  // share the rate-limit bucket above. Fail closed if Upstash is unreachable.
  const isByo = Boolean(byoKey)
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
        // ── 5. Token limit pre-check (fail closed) ────────────────────────
        // The 12k ceiling is the FREE-TIER infra control; a BYO key LIFTS it
        // (only the 190k model-context guard below applies to BYO) — mirroring
        // the !isByo spend-cap gating above. Uses the Anthropic countTokens
        // API; falls back to char/4 when the API is unavailable.
        if (!isByo) {
          const inputCount = await countInputTokens(fullAssembledPrompt, judgeClient)
          if (inputCount > MAX_INPUT_TOKENS) {
            if (refundSpend) { await refundSpend(); refundSpend = null }
            dataStream.writeData({
              type: 'error',
              message: `Assembled context exceeds the ${MAX_INPUT_TOKENS}-token limit (${inputCount} tokens). Reduce record size or use retrieve mode.`,
            })
            return
          }
        }

        // Fallback 190k pre-check via char estimate (extra safety net)
        const estimatedInputTokens = estimateTokens(fullAssembledPrompt)
        if (estimatedInputTokens > MODEL_CONTEXT_LIMIT) {
          if (refundSpend) { await refundSpend(); refundSpend = null }
          dataStream.writeData({
            type: 'error',
            message: `Assembled context (~${estimatedInputTokens} tokens) exceeds model context limit (${MODEL_CONTEXT_LIMIT} tokens). Reduce record size or use retrieve mode.`,
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
        const [output, usage] = await Promise.all([result.text, result.usage])

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

        const [faithfulnessResult, sectionHitResult] = await Promise.all([
          scoreFaithfulness(evalCase, judgeClient),
          Promise.resolve(scoreSectionHit(evalCase)),
        ])

        // ── 10. Stream eval results ───────────────────────────────────────
        dataStream.writeData({
          type: 'eval',
          faithfulness: faithfulnessResult,
          sectionHit: sectionHitResult,
        } as unknown as JSONValue)

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
                }
              : undefined,
          sectionHit: sectionHitResult,
          output,
          scorerResults: [faithfulnessResult, sectionHitResult],
          generationModel: model,
          judgeModel,
          embeddingModel: mode === 'retrieve' ? EMBEDDING_MODEL : 'none',
          inputType: 'query',
          tokens: {
            input: usage.promptTokens,
            output: usage.completionTokens,
            estCostUsd,
          },
          claimCount: faithfulnessResult.claims.length,
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
      // Convert Anthropic over-context 400s to a graceful user-facing message
      if (isOverContextError(error)) {
        return 'Request exceeds model context. Please reduce the record size or use retrieve mode with a smaller k value.'
      }
      return error instanceof Error ? error.message : 'An unexpected error occurred.'
    },
  })
}
