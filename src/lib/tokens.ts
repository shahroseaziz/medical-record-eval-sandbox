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
// CHARS_PER_TOKEN is fit to the dense clinical-record text this app actually
// sends (SNOMED codes, URLs, ISO-8601 timestamps): that text tokenizes at
// ~2.05–2.27 chars/token, far denser than the ~4 chars/token of English prose.
// A naive char/4 estimate under-counts these records ~2× — it would let an
// oversized payload slip past the budget (fail-open). 2.2 lands within ~7% of
// the API count across every record-sized reference fixture.
export const CHARS_PER_TOKEN = 2.2

// Hot-path safety margin. Budget decisions bias toward over-counting so a small
// approximation error never lets an oversized payload through (fail-closed).
// 15% covers the observed ±7% approximation error plus headroom; verified
// against the reference fixtures (estimateInputTokens >= the API count for all).
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
  return Math.ceil(text.length / CHARS_PER_TOKEN)
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
