export const runtime = 'nodejs'
export const maxDuration = 120

import { NextRequest } from 'next/server'
import { createDataStreamResponse, streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import Anthropic from '@anthropic-ai/sdk'
import { retrieve } from '@/lib/rag/index'
import type { RetrievedChunk } from '@/lib/rag/index'
import { scoreFaithfulness, scoreSectionHit } from '@/lib/eval/index'
import type { EvalCase } from '@/lib/eval/index'
import { withClient } from '@/lib/db/index'
import { estimateTokens } from '@/lib/tokens'
import { MODEL as EMBEDDING_MODEL } from '@/lib/voyage'
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

function buildPrompt(query: string, groundingContext: string): string {
  return `You are a medical record analyst. Answer the question based ONLY on the provided medical record context. Do not use outside knowledge or make assumptions beyond what is stated.

MEDICAL RECORD CONTEXT:
${groundingContext}

QUESTION:
${query}

Provide a thorough, accurate answer based solely on the information in the medical record context above. If the context does not contain sufficient information to answer the question, say so explicitly.`
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
    apiKey,
    model = DEFAULT_GENERATION_MODEL,
    judgeModel = DEFAULT_JUDGE_MODEL,
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
      { status: 503 }
    )
  }

  const anthropicApiKey = apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is required' }, { status: 503 })
  }

  const aiProvider = createAnthropic({ apiKey: anthropicApiKey })
  const judgeClient = new Anthropic({ apiKey: anthropicApiKey })
  const caseId = `run-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`

  return createDataStreamResponse({
    execute: async (dataStream) => {
      // ── 1. Retrieval (retrieve mode only) ────────────────────
      let chunks: RetrievedChunk[] = []
      let groundingContext = ''

      if (mode === 'retrieve') {
        const retrieveResult = await retrieve(patientId, query, k)
        chunks = retrieveResult.chunks
        groundingContext = buildGroundingContext('retrieve', chunks)

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
      } else {
        groundingContext = buildGroundingContext('stuff', [], record)
      }

      // ── 2. Assemble prompt ────────────────────────────────────
      const assembledPrompt = buildPrompt(query, groundingContext)

      // Over-context pre-check (catches large records before hitting Anthropic)
      const estimatedInputTokens = estimateTokens(assembledPrompt)
      if (estimatedInputTokens > MODEL_CONTEXT_LIMIT) {
        dataStream.writeData({
          type: 'error',
          message: `Assembled prompt (~${estimatedInputTokens} tokens) exceeds model context limit (${MODEL_CONTEXT_LIMIT} tokens). Reduce record size or use retrieve mode.`,
        })
        return
      }

      // ── 3. Stream generation tokens ──────────────────────────
      const result = streamText({
        model: aiProvider(model),
        prompt: assembledPrompt,
      })

      // Merges text deltas into the data stream as they arrive
      result.mergeIntoDataStream(dataStream)

      // ── 4. Collect full output + usage ───────────────────────
      const [output, usage] = await Promise.all([result.text, result.usage])

      // ── 5. Run scorers ────────────────────────────────────────
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

      // ── 6. Stream faithfulness rationale + eval results ──────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dataStream.writeData({
        type: 'eval',
        faithfulness: faithfulnessResult as any,
        sectionHit: sectionHitResult as any,
      } as any)

      // ── 7. Persist trace to DB ────────────────────────────────
      const embeddingTokens = mode === 'retrieve' ? estimateTokens(query) : 0
      const estCostUsd =
        usage.promptTokens * INPUT_COST_PER_TOKEN +
        usage.completionTokens * OUTPUT_COST_PER_TOKEN +
        embeddingTokens * EMBED_COST_PER_TOKEN

      const trace: RunTrace = {
        caseId,
        ragMode: mode,
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
                assembledPrompt,
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
      }

      await withClient(async (client) => {
        await client.query('INSERT INTO traces (trace) VALUES ($1)', [JSON.stringify(trace)])
      })
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
