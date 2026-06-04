import Anthropic from '@anthropic-ai/sdk'
import type { EvalCase, FaithfulnessResult, FaithfulnessClaim } from '../types'

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 4096

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'extract_claims',
  description: 'Extract every atomic factual claim from the text as a flat list',
  input_schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: { type: 'string', description: 'A single atomic factual assertion' },
        description: 'All atomic factual claims in the text',
      },
    },
    required: ['claims'],
  },
}

const VERDICT_TOOL: Anthropic.Tool = {
  name: 'verdict_claims',
  description: 'Judge each claim as supported, unsupported, or partial against the grounding context',
  input_schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            claim: { type: 'string' },
            verdict: {
              type: 'string',
              enum: ['supported', 'unsupported', 'partial'],
            },
            rationale: { type: 'string', description: 'Brief evidence citation or explanation' },
          },
          required: ['claim', 'verdict', 'rationale'],
        },
      },
    },
    required: ['verdicts'],
  },
}

interface ExtractInput {
  claims: string[]
}

interface RawVerdict {
  claim: string
  verdict: string
  rationale: string
}

interface VerdictInput {
  verdicts: RawVerdict[]
}

function isExtractInput(x: unknown): x is ExtractInput {
  if (typeof x !== 'object' || x === null) return false
  const cast = x as Record<string, unknown>
  return Array.isArray(cast['claims']) && cast['claims'].every((c: unknown) => typeof c === 'string')
}

function isVerdictInput(x: unknown): x is VerdictInput {
  if (typeof x !== 'object' || x === null) return false
  const cast = x as Record<string, unknown>
  if (!Array.isArray(cast['verdicts'])) return false
  return cast['verdicts'].every((v: unknown) => {
    if (typeof v !== 'object' || v === null) return false
    const vcast = v as Record<string, unknown>
    return (
      typeof vcast['claim'] === 'string' &&
      typeof vcast['verdict'] === 'string' &&
      typeof vcast['rationale'] === 'string'
    )
  })
}

function getGrounding(evalCase: EvalCase): string {
  if (evalCase.mode === 'retrieve') {
    const chunks = evalCase.retrievedChunks ?? []
    if (chunks.length === 0) return '(no retrieved chunks provided)'
    return chunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
  }
  return evalCase.record ?? '(no record provided)'
}

export function buildExtractPrompt(output: string): string {
  return `You are a factual claim extractor. Your task is to decompose the following model output into atomic factual claims.

An atomic claim is a single, self-contained factual assertion that can be independently verified or falsified. Do not evaluate truth — only extract claims verbatim from the text.

OUTPUT TO ANALYZE:
${output}

Extract all atomic factual claims from this text. Return them as a flat list. If the text contains no factual claims (e.g. only questions or greetings), return an empty list.`
}

export function buildVerdictPrompt(claims: string[], groundingContext: string): string {
  const numberedClaims = claims.map((c, i) => `${i + 1}. ${c}`).join('\n')
  return `You are a faithfulness judge. Evaluate each claim ONLY against the grounding context below. Do not use outside knowledge.

GROUNDING CONTEXT (sole source of truth):
${groundingContext}

CLAIMS TO EVALUATE:
${numberedClaims}

For each claim assign:
- "supported": directly and explicitly supported by the context
- "unsupported": contradicted by the context, or not present at all
- "partial": mentioned but with caveats, hedging, or incomplete coverage

Evaluate strictly. A claim is NOT supported unless the context explicitly backs it.`
}

async function tryExtract(
  client: Anthropic,
  prompt: string
): Promise<ExtractInput | null> {
  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_claims' },
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content.find((c) => c.type === 'tool_use')
    if (!block || block.type !== 'tool_use') return null
    return isExtractInput(block.input) ? block.input : null
  } catch {
    return null
  }
}

async function tryVerdict(
  client: Anthropic,
  prompt: string
): Promise<VerdictInput | null> {
  try {
    const response = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      tools: [VERDICT_TOOL],
      tool_choice: { type: 'tool', name: 'verdict_claims' },
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content.find((c) => c.type === 'tool_use')
    if (!block || block.type !== 'tool_use') return null
    return isVerdictInput(block.input) ? block.input : null
  } catch {
    return null
  }
}

// A structured-output call occasionally returns an unparseable response even at
// temperature 0; that is transient noise, not a regression. Retry a few times before
// declaring a terminal judge error. 4 attempts makes a spurious failure rare enough
// that it stops red-X'ing otherwise-correct PRs through the build-CI eval gate.
const JUDGE_PARSE_ATTEMPTS = 4

async function extractWithRetry(
  client: Anthropic,
  prompt: string
): Promise<ExtractInput | null> {
  for (let i = 0; i < JUDGE_PARSE_ATTEMPTS; i++) {
    const r = await tryExtract(client, prompt)
    if (r !== null) return r
  }
  return null
}

async function verdictWithRetry(
  client: Anthropic,
  prompt: string
): Promise<VerdictInput | null> {
  for (let i = 0; i < JUDGE_PARSE_ATTEMPTS; i++) {
    const r = await tryVerdict(client, prompt)
    if (r !== null) return r
  }
  return null
}

function normalizeVerdict(v: string): FaithfulnessClaim['verdict'] {
  if (v === 'supported' || v === 'unsupported' || v === 'partial') return v
  return 'unsupported'
}

export async function scoreFaithfulness(
  evalCase: EvalCase,
  client?: Anthropic
): Promise<FaithfulnessResult> {
  const anthropicClient =
    client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // Grounding is mode-aware. Task query and expectedOutput are NEVER included.
  const groundingContext = getGrounding(evalCase)
  const extractPrompt = buildExtractPrompt(evalCase.output)

  const extractResult = await extractWithRetry(anthropicClient, extractPrompt)

  if (extractResult === null) {
    return {
      scorer: 'faithfulness',
      score: null,
      errored: true,
      errorMessage: 'Claim extraction failed after retry — response unparseable',
      claims: [],
      extractPrompt,
      verdictPrompt: '',
    }
  }

  if (extractResult.claims.length === 0) {
    return {
      scorer: 'faithfulness',
      score: 1.0,
      zeroClaimFlag: true,
      claims: [],
      extractPrompt,
      verdictPrompt: '',
    }
  }

  const verdictPrompt = buildVerdictPrompt(extractResult.claims, groundingContext)
  const verdictResult = await verdictWithRetry(anthropicClient, verdictPrompt)

  if (verdictResult === null) {
    return {
      scorer: 'faithfulness',
      score: null,
      errored: true,
      errorMessage: 'Claim verdicting failed after retry — response unparseable',
      claims: [],
      extractPrompt,
      verdictPrompt,
    }
  }

  const claims: FaithfulnessClaim[] = verdictResult.verdicts.map((v) => ({
    claim: v.claim,
    verdict: normalizeVerdict(v.verdict),
    rationale: v.rationale,
  }))

  // partial counts as NOT supported
  const supported = claims.filter((c) => c.verdict === 'supported').length
  const score = claims.length > 0 ? supported / claims.length : 1.0

  return {
    scorer: 'faithfulness',
    score,
    claims,
    extractPrompt,
    verdictPrompt,
  }
}
