import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  approxTokens,
  estimateTokens,
  estimateInputTokens,
  assertWithinTokenLimit,
  TokenLimitError,
  MAX_INPUT_TOKENS,
  CHARS_PER_TOKEN,
  TOKEN_SAFETY_MARGIN,
} from '../tokens'
import tokenCounts from '../../../evals/fixtures/token-counts.json'

// SHA-78 / arch S25: the hot path approximates token counts LOCALLY — no per-run
// count_tokens round-trip. These fixtures are the committed, API-counted reference
// set (maintainer count_tokens pass, evals/fixtures/token-counts.json). The worker
// asserts the local counter against them and NEVER calls the Anthropic API.

interface TokenFixture {
  id: string
  sha256: string
  chars: number
  api_input_tokens: number
  text: string
}

const fixtures = tokenCounts.fixtures as TokenFixture[]

// The approximation is fit to record-sized inputs; per-token overhead dominates
// tiny strings (a 20-token query is unrepresentative). Margin assertions apply to
// fixtures large enough to be budget-relevant; the fail-closed invariant applies
// to ALL fixtures regardless of size.
const SUBSTANTIAL_MIN_TOKENS = 100
// Verified headroom: the approximation lands within ~7% of the API count on every
// substantial fixture. 15% is the asserted bound — comfortably above the observed
// error without being brittle.
const APPROX_MARGIN = 0.15

describe('token-count reference fixtures', () => {
  it('are intact (sha256 of each fixture text matches the committed hash)', () => {
    for (const fx of fixtures) {
      const sha = createHash('sha256').update(fx.text).digest('hex')
      expect(sha, `fixture ${fx.id} text drifted from its committed sha256`).toBe(fx.sha256)
      expect(fx.text.length).toBe(fx.chars)
    }
  })

  it('covers the pinned Agustin437 Hills818 retrieve-mode assembly', () => {
    const ids = fixtures.map((f) => f.id)
    expect(ids).toContain('agustin437-hills818-full-record')
    expect(ids).toContain('agustin437-hills818-k6-assembly')
  })
})

describe('approxTokens() vs committed API counts', () => {
  const substantial = fixtures.filter((f) => f.api_input_tokens >= SUBSTANTIAL_MIN_TOKENS)

  it('has fixtures to assert against', () => {
    expect(substantial.length).toBeGreaterThan(0)
  })

  for (const fx of fixtures.filter((f) => f.api_input_tokens >= SUBSTANTIAL_MIN_TOKENS)) {
    it(`is within ±${APPROX_MARGIN * 100}% of the API count for ${fx.id}`, () => {
      const approx = approxTokens(fx.text)
      const relErr = Math.abs(approx - fx.api_input_tokens) / fx.api_input_tokens
      expect(
        relErr,
        `${fx.id}: approx=${approx} api=${fx.api_input_tokens} relErr=${relErr.toFixed(3)}`,
      ).toBeLessThanOrEqual(APPROX_MARGIN)
    })
  }
})

describe('estimateInputTokens() fails closed against the reference set', () => {
  // The safety-margined estimate must NEVER under-count the true API count —
  // otherwise an oversized payload could slip past a budget gate. This holds for
  // EVERY fixture, including the tiny ones the raw approximation over-estimates.
  for (const fx of fixtures) {
    it(`never under-counts ${fx.id}`, () => {
      expect(
        estimateInputTokens(fx.text),
        `${fx.id}: estimate must be >= api count ${fx.api_input_tokens}`,
      ).toBeGreaterThanOrEqual(fx.api_input_tokens)
    })
  }
})

describe('approxTokens() / estimateTokens()', () => {
  it('uses CHARS_PER_TOKEN with ceiling division', () => {
    const text = 'a'.repeat(2200)
    expect(approxTokens(text)).toBe(Math.ceil(2200 / CHARS_PER_TOKEN))
    expect(approxTokens('')).toBe(0)
  })

  it('estimateTokens is the raw approximation (no safety margin) for cost/trace use', () => {
    const text = 'lorem ipsum '.repeat(50)
    expect(estimateTokens(text)).toBe(approxTokens(text))
  })

  it('estimateInputTokens applies the safety margin on top of the approximation', () => {
    const text = 'x'.repeat(10_000)
    expect(estimateInputTokens(text)).toBe(Math.ceil(approxTokens(text) * TOKEN_SAFETY_MARGIN))
    expect(estimateInputTokens(text)).toBeGreaterThan(approxTokens(text))
  })
})

describe('assertWithinTokenLimit() (synchronous, no API call)', () => {
  it('returns the estimate when within the limit', () => {
    const count = assertWithinTokenLimit('safe input')
    expect(count).toBe(estimateInputTokens('safe input'))
  })

  it('throws TokenLimitError when the estimate exceeds the limit', () => {
    // ~12k tokens worth of dense text → over MAX_INPUT_TOKENS once margined.
    const tooLong = 'x'.repeat(MAX_INPUT_TOKENS * CHARS_PER_TOKEN)
    expect(() => assertWithinTokenLimit(tooLong)).toThrow(TokenLimitError)
  })

  it('rejects a 6 MB record (clearly over the 12k ceiling)', () => {
    const sixMb = 'x'.repeat(6 * 1024 * 1024)
    expect(() => assertWithinTokenLimit(sixMb)).toThrow(TokenLimitError)
  })

  it('honours a custom limit argument', () => {
    const text = 'x'.repeat(4_400) // ~2000 approx tokens
    expect(() => assertWithinTokenLimit(text, 100)).toThrow(TokenLimitError)
    expect(assertWithinTokenLimit(text, 1_000_000)).toBe(estimateInputTokens(text))
  })

  it('TokenLimitError carries the (margined) estimate', () => {
    const tooLong = 'x'.repeat(MAX_INPUT_TOKENS * CHARS_PER_TOKEN * 2)
    try {
      assertWithinTokenLimit(tooLong)
      throw new Error('expected TokenLimitError')
    } catch (e) {
      expect(e).toBeInstanceOf(TokenLimitError)
      expect((e as TokenLimitError).tokenCount).toBe(estimateInputTokens(tooLong))
    }
  })
})
