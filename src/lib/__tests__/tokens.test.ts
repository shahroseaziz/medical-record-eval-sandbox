import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  approxTokens,
  estimateTokens,
  estimateInputTokens,
  assertWithinTokenLimit,
  charsPerToken,
  denseCharFraction,
  TokenLimitError,
  MAX_INPUT_TOKENS,
  CHARS_PER_TOKEN,
  CHARS_PER_TOKEN_DENSE,
  CHARS_PER_TOKEN_PROSE,
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

describe('charsPerToken() / denseCharFraction() (per-input density)', () => {
  const DENSE = '2024-01-15T08:30:00Z 73211007 |Hypertension| 250604008 http://snomed.info/sct/900'
  const PROSE = 'The patient was seen in the clinic today and reported feeling generally well.'

  it('classifies code/timestamp-heavy text as dense (uses the dense ratio)', () => {
    expect(denseCharFraction(DENSE)).toBeGreaterThan(0.25)
    expect(charsPerToken(DENSE)).toBeCloseTo(CHARS_PER_TOKEN_DENSE, 5)
  })

  it('classifies natural-language prose as low-density (near the prose ratio)', () => {
    expect(denseCharFraction(PROSE)).toBeLessThan(0.05)
    expect(charsPerToken(PROSE)).toBeGreaterThan(CHARS_PER_TOKEN_DENSE)
    expect(charsPerToken(PROSE)).toBeLessThanOrEqual(CHARS_PER_TOKEN_PROSE)
  })

  it('clamps within [dense, prose] and is monotone in density', () => {
    expect(charsPerToken('aaaaaaaa')).toBe(CHARS_PER_TOKEN_PROSE) // 0% dense → prose end
    expect(charsPerToken('12345678')).toBe(CHARS_PER_TOKEN_DENSE) // 100% dense → dense end
    expect(charsPerToken('aaaa1234')).toBeLessThan(CHARS_PER_TOKEN_PROSE)
    expect(charsPerToken('aaaa1234')).toBeGreaterThanOrEqual(CHARS_PER_TOKEN_DENSE)
  })

  it('CHARS_PER_TOKEN back-compat alias is the dense baseline', () => {
    expect(CHARS_PER_TOKEN).toBe(CHARS_PER_TOKEN_DENSE)
  })
})

describe('prose-density inputs: fail-closed but no gross over-count (SHA-78 reviewer fix)', () => {
  // Previously the margin assertions only ran on clinical-density fixtures (the
  // ±15% block filters to ≥100 tokens, which are all dense). These validate the
  // PROSE side: still never under-counts, but the flat-2.2 ~2x over-count is gone.
  const proseFixtures = fixtures.filter((f) => denseCharFraction(f.text) < 0.15)

  it('the committed set includes prose-density fixtures', () => {
    expect(proseFixtures.length).toBeGreaterThan(0)
  })

  for (const fx of proseFixtures) {
    it(`never under-counts prose fixture ${fx.id}`, () => {
      expect(estimateInputTokens(fx.text)).toBeGreaterThanOrEqual(fx.api_input_tokens)
    })
  }

  // The adaptive estimator keeps the margined prose estimate within ~1.6x of the
  // API count, so the 12k ceiling no longer rejects ordinary prose at ~5.7k real
  // tokens. A flat 2.2 chars/token produced up to ~2.3x here.
  const PROSE_OVERCOUNT_CEILING = 1.6
  for (const fx of proseFixtures) {
    it(`estimate stays within ${PROSE_OVERCOUNT_CEILING}x of the API count for ${fx.id}`, () => {
      const ratio = estimateInputTokens(fx.text) / fx.api_input_tokens
      expect(
        ratio,
        `${fx.id}: estimate ${estimateInputTokens(fx.text)} vs api ${fx.api_input_tokens}`,
      ).toBeLessThanOrEqual(PROSE_OVERCOUNT_CEILING)
    })
  }

  it('a long English narrative is fail-closed yet not over-rejected (~1.3x, not the old ~2.1x)', () => {
    const narrative =
      'The patient was seen in the clinic today and reported feeling generally well overall. '.repeat(60)
    const realTokensApprox = narrative.length / 4 // English prose ≈ 4 chars/token
    const estimate = estimateInputTokens(narrative)
    expect(estimate).toBeGreaterThanOrEqual(Math.ceil(realTokensApprox)) // fail-closed
    expect(estimate / realTokensApprox).toBeLessThan(1.6) // not the flat-2.2 blow-up
  })
})

describe('approxTokens() / estimateTokens()', () => {
  it('uses the per-input chars/token with ceiling division', () => {
    const prose = 'a'.repeat(2200) // all-alpha → prose ratio
    expect(approxTokens(prose)).toBe(Math.ceil(2200 / CHARS_PER_TOKEN_PROSE))
    const dense = '1'.repeat(2200) // all-digit → dense ratio
    expect(approxTokens(dense)).toBe(Math.ceil(2200 / CHARS_PER_TOKEN_DENSE))
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
    // Prose-density text (CHARS_PER_TOKEN_PROSE) large enough to clear the ceiling
    // once margined: ~48k chars → ~13.7k approx → ~15.8k margined > 12k.
    const tooLong = 'x'.repeat(MAX_INPUT_TOKENS * 4)
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
