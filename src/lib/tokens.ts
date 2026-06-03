import type Anthropic from '@anthropic-ai/sdk'

export const MAX_INPUT_TOKENS = 12_000
export const MAX_OUTPUT_TOKENS = 1_000

export class TokenLimitError extends Error {
  constructor(public readonly tokenCount: number) {
    super(`Input exceeds token limit: ${tokenCount} tokens (max ${MAX_INPUT_TOKENS})`)
    this.name = 'TokenLimitError'
  }
}

// Char-based estimate (~4 chars per English token). Used as fallback when the
// Anthropic countTokens API is unavailable — deliberately rounds up so we fail
// closed on uncertainty rather than letting oversized inputs through.
export function estimateTokensFromChars(text: string): number {
  return Math.ceil(text.length / 4)
}

// Backward-compatible alias used by the 190k model-context pre-check.
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text)
}

// Count input tokens via the Anthropic countTokens API (free, no generation).
// Falls back to char/4 estimation when the API is unavailable.
// Either way, the result is used to gate on MAX_INPUT_TOKENS — fail closed.
export async function countInputTokens(text: string, client: Anthropic): Promise<number> {
  try {
    const result = await client.messages.countTokens({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: text }],
    })
    return result.input_tokens
  } catch {
    return estimateTokensFromChars(text)
  }
}

// Throws TokenLimitError if the input exceeds MAX_INPUT_TOKENS.
// Fails closed: rejects when count > limit regardless of whether the exact count
// came from the API or the char-based fallback.
export async function assertWithinTokenLimit(text: string, client: Anthropic): Promise<number> {
  const count = await countInputTokens(text, client)
  if (count > MAX_INPUT_TOKENS) {
    throw new TokenLimitError(count)
  }
  return count
}
