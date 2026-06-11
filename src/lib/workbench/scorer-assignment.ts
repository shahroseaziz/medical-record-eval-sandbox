// ── E25 — scorer-assignment derivation (derived-with-override) ───────────────
//
// `fieldScorers` is DERIVED from what the user authored, visibly, with override:
//
//   authored expectedStructured (field builder) → structured: structured-diff
//   authored expectedProse                      → prose: reference-judge
//   neither                                     → prose: faithfulness
//                                                 (grounding is the truth standard)
//
// This supersedes the shipped capture flow's hardcoded `{ prose: 'faithfulness' }`
// regardless of authored reference (pitfall #15786 — an authored prose reference
// that never reached the scorer, so the reference had NO effect on the score). The
// reference-effect regression test in __tests__/scorer-assignment.test.ts pins the
// fix: identical cases with different references now produce different scores.
//
// Truth-standard choice is a property of AUTHORSHIP, not a global mode — the
// derived assignment renders as per-field evaluator chips (`scorerChips`).

import type { BenchFieldScorer } from '@/lib/cases'

/** The expected-output fields a scorer can target on the bench path. */
export type ExpectedFieldKey = 'prose' | 'structured'

/** The minimal authored shape derivation reads — works for both v3 and v4 cases. */
export interface AuthoredExpected {
  expectedProse?: string
  /** v4 field-builder rows, or a v3 free record; either is "structured present" when non-empty. */
  expectedStructured?: unknown
}

/** True when the user authored a non-empty prose reference. */
export function hasAuthoredProse(expectedProse?: string): boolean {
  return typeof expectedProse === 'string' && expectedProse.trim().length > 0
}

/** True when the user authored a non-empty structured expected output. */
export function hasAuthoredStructured(expectedStructured?: unknown): boolean {
  if (expectedStructured == null) return false
  if (Array.isArray(expectedStructured)) return expectedStructured.length > 0
  if (typeof expectedStructured === 'object') return Object.keys(expectedStructured).length > 0
  return false
}

/**
 * Derive the per-field scorer assignment from authored content (E25), then apply
 * any per-field overrides. An override only takes effect for a field the
 * derivation actually produced — you cannot point a scorer at a field with no
 * expected value (the one exception being the no-answer-key default below, where
 * `prose: faithfulness` grades the captured output against its grounding).
 */
export function deriveFieldScorers(
  authored: AuthoredExpected,
  overrides: Partial<Record<ExpectedFieldKey, BenchFieldScorer>> = {},
): Record<string, BenchFieldScorer> {
  const out: Record<string, BenchFieldScorer> = {}
  const hasProse = hasAuthoredProse(authored.expectedProse)
  const hasStructured = hasAuthoredStructured(authored.expectedStructured)

  if (hasStructured) out.structured = 'structured-diff'
  if (hasProse) out.prose = 'reference-judge'
  // Neither authored: faithfulness grades the output against grounding (no key).
  if (!hasProse && !hasStructured) out.prose = 'faithfulness'

  for (const field of Object.keys(out) as ExpectedFieldKey[]) {
    const override = overrides[field]
    if (override) out[field] = override
  }
  return out
}

// ── Evaluator chips (per case / per field) ───────────────────────────────────

export const SCORER_LABEL: Record<BenchFieldScorer, string> = {
  faithfulness: 'Faithfulness',
  'reference-judge': 'Reference judge',
  'structured-diff': 'Structured diff',
}

export const FIELD_LABEL: Record<string, string> = {
  prose: 'Prose',
  structured: 'Structured',
}

// Stable render order regardless of how the stored map was keyed.
const FIELD_ORDER: Record<string, number> = { prose: 0, structured: 1 }

export interface ScorerChip {
  field: string
  /** The assigned scorer; a plain string so legacy maps with non-v4 scorers still render. */
  scorer: string
  fieldLabel: string
  scorerLabel: string
  /** True when the assigned scorer equals the derived default for the field (no override). */
  isDefault: boolean
}

/**
 * Project a case's scorer assignment into per-field chips for the bench surface.
 * Uses the stored `fieldScorers` when present, otherwise the derived default; each
 * chip is tagged `isDefault` so an override reads visibly as a non-default choice.
 * `fieldScorers` is accepted as a loose string map so both v4 (`BenchFieldScorer`)
 * and legacy v3 (`FieldScorerMap`) cases render without a cast.
 */
export function scorerChips(
  c: AuthoredExpected & { fieldScorers?: Record<string, string> },
): ScorerChip[] {
  const defaults = deriveFieldScorers(c)
  const assigned: Record<string, string> =
    c.fieldScorers && Object.keys(c.fieldScorers).length > 0 ? c.fieldScorers : defaults

  return Object.entries(assigned)
    .map(([field, scorer]) => ({
      field,
      scorer,
      fieldLabel: FIELD_LABEL[field] ?? field,
      scorerLabel: SCORER_LABEL[scorer as BenchFieldScorer] ?? scorer,
      isDefault: defaults[field] === scorer,
    }))
    .sort((a, b) => (FIELD_ORDER[a.field] ?? 99) - (FIELD_ORDER[b.field] ?? 99))
}
