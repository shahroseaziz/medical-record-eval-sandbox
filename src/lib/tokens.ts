export const MAX_INPUT_TOKENS = 12_000
export const MAX_OUTPUT_TOKENS = 1_000

// ── Local token approximation (no per-run count_tokens round-trip) ───────────
// SHA-78 / arch S25: counting input tokens on the hot path must NOT call the
// Anthropic count_tokens API — that adds a round-trip and RPM pressure to every
// run. Instead we approximate locally and validate the approximation offline
// against committed API-counted reference fixtures (evals/fixtures/token-counts.json,
// produced by a maintainer count_tokens pass). The unit tests assert the
// approximation stays within ±margin of those fixtures and that the
// safety-margined estimate never under-counts them.
//
// Density is content-dependent and a SINGLE global ratio cannot serve both kinds
// of input this app sees:
//   • Dense clinical records (SNOMED codes, URLs, ISO-8601 timestamps) tokenize
//     at ~2.05–2.27 chars/token.
//   • Natural-language prose (a pasted narrative record, a long free-text query)
//     tokenizes at ~3.4–4.4 chars/token.
// A flat 2.2 keeps dense records fail-closed but over-counts prose ~1.8×, so the
// 12k free-tier ceiling would silently reject an English narrative at ~5.7k REAL
// tokens. We therefore pick the ratio PER INPUT from its character composition.
export const CHARS_PER_TOKEN_DENSE = 2.2
export const CHARS_PER_TOKEN_PROSE = 3.5
// Back-compat alias (the dense baseline). Prefer charsPerToken(text) below, which
// adapts to the input; this constant is the conservative end of that range.
export const CHARS_PER_TOKEN = CHARS_PER_TOKEN_DENSE

// "Dense" characters = digits and symbols (anything that is neither an ASCII
// letter nor whitespace). Prose runs ~2–3% dense chars; code/timestamp-heavy
// clinical text runs ~40%+. As that fraction climbs to DENSE_CHAR_PIVOT we
// interpolate chars/token down from the prose ratio toward the dense ratio, then
// clamp. The interpolation is monotone and biased conservative: any input that
// looks even slightly code-dense moves toward the denser (higher-token,
// fail-closed) ratio, and non-ASCII letters (accented names) count as dense too.
export const DENSE_CHAR_PIVOT = 0.25

export function denseCharFraction(text: string): number {
  if (text.length === 0) return 0
  let dense = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    const isAsciiAlpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    const isWhitespace =
      code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12
    if (!isAsciiAlpha && !isWhitespace) dense++
  }
  return dense / text.length
}

// Per-input chars/token: prose ratio for low-density text, dense ratio for
// code/timestamp-heavy text, linearly interpolated in between. Clamped to
// [CHARS_PER_TOKEN_DENSE, CHARS_PER_TOKEN_PROSE].
export function charsPerToken(text: string): number {
  const density = Math.min(1, denseCharFraction(text) / DENSE_CHAR_PIVOT)
  return CHARS_PER_TOKEN_PROSE - (CHARS_PER_TOKEN_PROSE - CHARS_PER_TOKEN_DENSE) * density
}

// Hot-path safety margin. Budget decisions bias toward over-counting so a small
// approximation error never lets an oversized payload through (fail-closed).
// 15% covers the observed ±7% approximation error plus headroom; verified
// against the reference fixtures (estimateInputTokens >= the API count for all,
// across both clinical-density and prose-density fixtures).
export const TOKEN_SAFETY_MARGIN = 1.15

export class TokenLimitError extends Error {
  constructor(public readonly tokenCount: number) {
    super(`Input exceeds token limit: ${tokenCount} tokens (max ${MAX_INPUT_TOKENS})`)
    this.name = 'TokenLimitError'
  }
}

// Raw local approximation of the Anthropic input-token count. Tuned to be close
// to the API count (no safety margin) — use this for cost/trace estimates, where
// an inflated number would distort reported spend. Use estimateInputTokens for
// budget gating.
export function approxTokens(text: string): number {
  if (text.length === 0) return 0
  return Math.ceil(text.length / charsPerToken(text))
}

// Budget-facing estimate: the raw approximation plus a safety margin so we
// fail closed (never under-count) when deciding whether a payload fits a limit.
export function estimateInputTokens(text: string): number {
  return Math.ceil(approxTokens(text) * TOKEN_SAFETY_MARGIN)
}

// Backward-compatible alias for the cost/trace estimate (no safety margin).
export function estimateTokens(text: string): number {
  return approxTokens(text)
}

// Synchronous, local budget check — no API call. Throws TokenLimitError carrying
// the (margined) estimate when the text exceeds `limit`; returns the estimate
// otherwise. Fails closed via the safety margin baked into estimateInputTokens.
export function assertWithinTokenLimit(text: string, limit: number = MAX_INPUT_TOKENS): number {
  const count = estimateInputTokens(text)
  if (count > limit) {
    throw new TokenLimitError(count)
  }
  return count
}
