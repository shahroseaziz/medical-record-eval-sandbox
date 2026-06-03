import { describe, it, expect, vi } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import {
  estimateTokensFromChars,
  countInputTokens,
  assertWithinTokenLimit,
  TokenLimitError,
  MAX_INPUT_TOKENS,
} from '../tokens'

// Build a minimal mock Anthropic client with a controllable countTokens response.
function makeClient(inputTokens: number): Anthropic {
  return {
    messages: {
      countTokens: vi.fn().mockResolvedValue({ input_tokens: inputTokens }),
    },
  } as unknown as Anthropic
}

function makeFailingClient(): Anthropic {
  return {
    messages: {
      countTokens: vi.fn().mockRejectedValue(new Error('API unavailable')),
    },
  } as unknown as Anthropic
}

describe('estimateTokensFromChars()', () => {
  it('returns ceil(length / 4)', () => {
    expect(estimateTokensFromChars('abcd')).toBe(1)
    expect(estimateTokensFromChars('abcde')).toBe(2)
    expect(estimateTokensFromChars('')).toBe(0)
  })
})

describe('countInputTokens()', () => {
  it('uses the Anthropic countTokens API when available', async () => {
    const client = makeClient(8_000)
    const count = await countInputTokens('hello world', client)
    expect(count).toBe(8_000)
    expect(
      (client.messages.countTokens as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(1)
  })

  it('falls back to char/4 estimate when the API throws', async () => {
    const text = 'a'.repeat(8_000) // 8000 chars → 2000 tokens estimated
    const client = makeFailingClient()
    const count = await countInputTokens(text, client)
    expect(count).toBe(2_000) // 8000 / 4
  })
})

describe('assertWithinTokenLimit()', () => {
  it('resolves with the token count when within limit', async () => {
    const client = makeClient(MAX_INPUT_TOKENS - 1)
    const count = await assertWithinTokenLimit('safe input', client)
    expect(count).toBe(MAX_INPUT_TOKENS - 1)
  })

  it('throws TokenLimitError when API returns count > MAX_INPUT_TOKENS', async () => {
    const client = makeClient(MAX_INPUT_TOKENS + 1)
    await expect(assertWithinTokenLimit('too long', client)).rejects.toBeInstanceOf(
      TokenLimitError,
    )
  })

  it('rejects a 6 MB record via the API path (over-12k rejected pre-call)', async () => {
    // A 6 MB record is ~1.5M tokens — clearly over the 12k limit
    const sixMb = 'x'.repeat(6 * 1024 * 1024)
    const client = makeClient(1_500_000)
    await expect(assertWithinTokenLimit(sixMb, client)).rejects.toBeInstanceOf(TokenLimitError)
  })

  // ── Tokenizer-fallback fails closed ──────────────────────────────────────
  // When the Anthropic API is unavailable, the char/4 fallback is used.
  // Inputs that the fallback estimates as > 12k must still be rejected.

  it('tokenizer-fallback fails closed: rejects >12k chars via fallback estimate', async () => {
    // 12k tokens × 4 chars/token = 48k chars → fallback returns 12k, which equals MAX
    // Use 48001 chars to push just above 12k with ceiling division
    const overLimit = 'a'.repeat(MAX_INPUT_TOKENS * 4 + 4) // → estimateTokensFromChars = 12001
    const client = makeFailingClient()
    await expect(assertWithinTokenLimit(overLimit, client)).rejects.toBeInstanceOf(
      TokenLimitError,
    )
  })

  it('tokenizer-fallback: allows input that estimates within limit', async () => {
    // 40k chars → char/4 = 10k tokens < 12k limit
    const withinLimit = 'a'.repeat(40_000)
    const client = makeFailingClient()
    const count = await assertWithinTokenLimit(withinLimit, client)
    expect(count).toBe(10_000)
  })

  it('TokenLimitError carries the token count', async () => {
    const client = makeClient(99_999)
    const err = await assertWithinTokenLimit('x', client).catch((e) => e)
    expect(err).toBeInstanceOf(TokenLimitError)
    expect((err as TokenLimitError).tokenCount).toBe(99_999)
  })
})
