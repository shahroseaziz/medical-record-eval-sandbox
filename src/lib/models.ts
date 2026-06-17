// ── Single source of provider model-ID strings ──────────────────────────────
//
// Rule 13: the model id is part of every trace, and a silent model swap changes
// scoring behaviour with no code change. So each pinned model id lives in EXACTLY
// one place — here — and every first-party module that needs an id imports it.
//
// A grep proves no model-ID literal exists elsewhere across the source globs
// (src/**, scripts/**, evals/*.ts); committed provenance data (evals/results,
// evals/golden, evals/fixtures, e2e/fixtures, persisted trace JSON) records the id
// that produced it and is deliberately exempt — it must not be rewritten to an
// import. See scripts/check-model-id-literals.sh for the enforced grep.

/** Claude generation model — default for /api/run generation. */
export const GENERATION_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Claude judge model — faithfulness, reference, and criteria judges plus the score
 * routes. Pinned identically to the generation model today; kept as a distinct
 * named export so a future judge/gen split changes one line, not a grep.
 */
export const JUDGE_MODEL = 'claude-haiku-4-5-20251001'

/**
 * Claude bring-your-own-key model (SHA-156 N6). The notebook's free tier runs
 * GENERATION_MODEL on the shared limit; a user who stores their own API key has
 * the ACTIVE model switched to this id AND the rate/spend caps lifted. Pinned
 * here so the id-literal grep + model-swap gate see it from the single source —
 * the notebook header reads it via import, never as a literal.
 */
export const BYO_MODEL = 'claude-sonnet-4-6'

/** Voyage embedding model — retrieval embeddings. `lib/voyage` re-exports this. */
export const EMBEDDING_MODEL = 'voyage-3.5'

/** Every model id this app pins — used by the model-swap gate guard and the grep. */
export const MODEL_IDS = [GENERATION_MODEL, JUDGE_MODEL, BYO_MODEL, EMBEDDING_MODEL] as const

// ── Model-family predicates ──────────────────────────────────────────────────
// Calibration/observability buckets a trace's RECORDED model (which may be any
// historical id) by family. Centralised here so the id-substring matching is not
// re-hardcoded at each call site.

/** True when the model id belongs to the Claude Haiku family. */
export function isHaikuModel(id: string): boolean {
  return id.includes('haiku')
}

/** True when the model id belongs to the Claude Sonnet family. */
export function isSonnetModel(id: string): boolean {
  return id.includes('sonnet')
}

// ── Human-facing model label ─────────────────────────────────────────────────
// The notebook header shows the ACTIVE model truthfully (e.g. "Haiku 4.5"). The
// label is DERIVED from the pinned id here, not written as a literal at the call
// site — so the single-source rule holds and the label cannot drift from the id.

const FAMILY_LABEL: Record<string, string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
}

/**
 * A short, human-facing name for a Claude model id — `claude-haiku-4-5-20251001`
 * → "Haiku 4.5", `claude-sonnet-4-6` → "Sonnet 4.6". The family comes from the
 * leading segment; the version is the run of 1–2 digit segments (a trailing
 * 8-digit date snapshot is excluded). Unknown shapes fall back to the raw id.
 */
export function modelDisplayName(id: string): string {
  const parts = id.replace(/^claude-/, '').split('-')
  const family = FAMILY_LABEL[parts[0]]
  if (!family) return id
  const version = parts.slice(1).filter((p) => /^\d{1,2}$/.test(p))
  return version.length ? `${family} ${version.join('.')}` : family
}
