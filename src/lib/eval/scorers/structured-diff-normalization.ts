/**
 * Normalization contract for the structured-diff scorer.
 *
 * The structured-diff scorer is a *field-by-field* reference comparison (the
 * prototype's per-field `{ name, dose }` compare). For that comparison to be
 * meaningful, two hand-authored / model-produced values that mean the same
 * clinical thing must normalize to the same canonical form *before* they are
 * diffed. This module is the single, documented home of those rules:
 *
 *   1. Canonical-unit table + dose canonicalization  (`canonicalizeDose`)
 *   2. Drug-name alias resolution                    (`normalizeName`)
 *   3. Duplicate-name collapse rule                   (`collapseDuplicates`)
 *
 * Every rule is deterministic and runs client-side (free, no model call).
 *
 * BLIND SPOTS (surfaced, never hidden — see `structured-diff.normalization.md`):
 *   - Alias resolution is purely lexical (salt-suffix stripping). It does NOT
 *     know that "Tylenol" == "acetaminophen"; brand↔generic mapping is out of
 *     scope and a false-negative source.
 *   - Salt stripping can merge two genuinely distinct salts that differ
 *     clinically. For electrolyte / mineral salts ("potassium chloride" vs
 *     "potassium citrate", "magnesium sulfate") this is systematic, so the anion
 *     is preserved when stripping would expose a bare mineral cation
 *     (MINERAL_TOKENS). For all OTHER salt strips that alter a name, the dropped
 *     tokens are returned (NameResolution.strippedSalts) so the scorer can emit a
 *     per-case blind spot — the merge is never invisible at scoring time.
 *   - Compound/concentration units ("mg/mL") are alias-normalized per side but
 *     NOT magnitude-converted across the slash; the scorer records a blind spot
 *     whenever a compound dose participates in a comparison.
 *   - Unparseable dose strings fall back to normalized text equality.
 */

// ── 1. Canonical-unit table ─────────────────────────────────────────────────
//
// Each entry maps a unit (and its spelling variants) to a canonical unit plus
// the multiplier that converts ONE of this unit into the canonical unit. Doses
// are only magnitude-comparable when they share a canonical unit (i.e. the same
// physical dimension): mass→mg, volume→mL. Dimensionless / activity units
// (unit, meq, %, form counts) are their own canonical unit with factor 1 and
// are compared by value only when the canonical unit matches.

interface UnitDef {
  /** Canonical unit symbol this alias resolves to. */
  canonical: string
  /** Multiply a value in this unit by `factor` to get the value in `canonical`. */
  factor: number
}

const UNIT_TABLE: Record<string, UnitDef> = {
  // mass → mg
  mg: { canonical: 'mg', factor: 1 },
  milligram: { canonical: 'mg', factor: 1 },
  milligrams: { canonical: 'mg', factor: 1 },
  g: { canonical: 'mg', factor: 1000 },
  gm: { canonical: 'mg', factor: 1000 },
  gram: { canonical: 'mg', factor: 1000 },
  grams: { canonical: 'mg', factor: 1000 },
  mcg: { canonical: 'mg', factor: 0.001 },
  ug: { canonical: 'mg', factor: 0.001 },
  µg: { canonical: 'mg', factor: 0.001 },
  microgram: { canonical: 'mg', factor: 0.001 },
  micrograms: { canonical: 'mg', factor: 0.001 },
  kg: { canonical: 'mg', factor: 1_000_000 },
  ng: { canonical: 'mg', factor: 0.000001 },
  nanogram: { canonical: 'mg', factor: 0.000001 },
  nanograms: { canonical: 'mg', factor: 0.000001 },

  // volume → mL
  ml: { canonical: 'mL', factor: 1 },
  milliliter: { canonical: 'mL', factor: 1 },
  milliliters: { canonical: 'mL', factor: 1 },
  millilitre: { canonical: 'mL', factor: 1 },
  millilitres: { canonical: 'mL', factor: 1 },
  cc: { canonical: 'mL', factor: 1 },
  l: { canonical: 'mL', factor: 1000 },
  liter: { canonical: 'mL', factor: 1000 },
  liters: { canonical: 'mL', factor: 1000 },
  litre: { canonical: 'mL', factor: 1000 },
  litres: { canonical: 'mL', factor: 1000 },

  // activity / count — canonical to themselves (no cross-unit conversion)
  unit: { canonical: 'unit', factor: 1 },
  units: { canonical: 'unit', factor: 1 },
  iu: { canonical: 'unit', factor: 1 },
  meq: { canonical: 'meq', factor: 1 },
  milliequivalent: { canonical: 'meq', factor: 1 },
  milliequivalents: { canonical: 'meq', factor: 1 },
  mmol: { canonical: 'mmol', factor: 1 },
  '%': { canonical: '%', factor: 1 },
  percent: { canonical: '%', factor: 1 },

  // dose forms (treated as units when written as a dose, e.g. "1 tablet")
  tab: { canonical: 'tablet', factor: 1 },
  tabs: { canonical: 'tablet', factor: 1 },
  tablet: { canonical: 'tablet', factor: 1 },
  tablets: { canonical: 'tablet', factor: 1 },
  cap: { canonical: 'capsule', factor: 1 },
  caps: { canonical: 'capsule', factor: 1 },
  capsule: { canonical: 'capsule', factor: 1 },
  capsules: { canonical: 'capsule', factor: 1 },
  puff: { canonical: 'puff', factor: 1 },
  puffs: { canonical: 'puff', factor: 1 },
  spray: { canonical: 'spray', factor: 1 },
  sprays: { canonical: 'spray', factor: 1 },
  drop: { canonical: 'drop', factor: 1 },
  drops: { canonical: 'drop', factor: 1 },
}

/** Resolve a single raw unit token to its canonical unit, or null if unknown. */
function resolveUnit(rawUnit: string): UnitDef | null {
  const key = rawUnit.trim().toLowerCase()
  return UNIT_TABLE[key] ?? null
}

export interface CanonicalDose {
  /** Original, untouched dose string. */
  raw: string
  /**
   * Canonical magnitude in the canonical unit, or null when the dose has no
   * numeric value or an unrecognized unit (then `canonicalUnit` is null too).
   */
  value: number | null
  /** Canonical unit symbol (e.g. 'mg', 'mL', 'unit'), or null when unresolved. */
  canonicalUnit: string | null
  /**
   * True when the dose parsed cleanly to value + recognized unit. When false the
   * scorer falls back to normalized-text equality and records a blind spot.
   */
  parseable: boolean
  /**
   * True when the unit is a compound / concentration unit (`mg/mL`). Each side of
   * the slash is alias-normalized, but NO magnitude conversion is performed across
   * it — a documented blind spot the scorer surfaces (see `recordDoseBlindSpots`).
   */
  compound: boolean
  /** Lowercased, whitespace-collapsed text form, used for the text fallback. */
  normalizedText: string
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Parse and canonicalize a dose string.
 *
 * Examples (canonical mass unit = mg):
 *   "500 mg"   → { value: 500,  canonicalUnit: 'mg', parseable: true }
 *   "0.5 g"    → { value: 500,  canonicalUnit: 'mg', parseable: true }
 *   "1,000 mcg"→ { value: 1,    canonicalUnit: 'mg', parseable: true }
 *   "10 mg/mL" → { value: 10,   canonicalUnit: 'mg/mL', parseable: true }  // per-side alias only
 *   "as directed" → { value: null, canonicalUnit: null, parseable: false }
 */
export function canonicalizeDose(raw: string): CanonicalDose {
  const normalizedText = normalizeText(raw)

  // Leading number (allow thousands separators and decimals) + trailing unit.
  const m = normalizedText.match(/^([\d][\d,]*\.?\d*|\.\d+)\s*(.+)$/)
  if (!m) {
    return {
      raw,
      value: null,
      canonicalUnit: null,
      parseable: false,
      compound: false,
      normalizedText,
    }
  }

  const value = parseFloat(m[1].replace(/,/g, ''))
  const unitPart = m[2].trim()
  if (Number.isNaN(value)) {
    return {
      raw,
      value: null,
      canonicalUnit: null,
      parseable: false,
      compound: false,
      normalizedText,
    }
  }

  // Compound / concentration unit "mg/mL": alias-normalize each side, do NOT
  // convert magnitude across the slash. Documented blind spot.
  if (unitPart.includes('/')) {
    const [num, den] = unitPart.split('/').map((p) => p.trim())
    const numDef = resolveUnit(num)
    const denDef = resolveUnit(den)
    if (numDef && denDef) {
      return {
        raw,
        value,
        canonicalUnit: `${numDef.canonical}/${denDef.canonical}`,
        parseable: true,
        compound: true,
        normalizedText,
      }
    }
    // A compound shape we could not fully resolve (e.g. "1 g/100mL") — unparseable,
    // but still flagged compound so the slash limitation is surfaced.
    return {
      raw,
      value: null,
      canonicalUnit: null,
      parseable: false,
      compound: true,
      normalizedText,
    }
  }

  const def = resolveUnit(unitPart)
  if (!def) {
    return {
      raw,
      value: null,
      canonicalUnit: null,
      parseable: false,
      compound: false,
      normalizedText,
    }
  }

  return {
    raw,
    value: value * def.factor,
    canonicalUnit: def.canonical,
    parseable: true,
    compound: false,
    normalizedText,
  }
}

/** Float tolerance for canonical-magnitude equality (handles e.g. 0.001 rounding). */
const DOSE_EPSILON = 1e-9

/**
 * Compare two canonical doses for clinical equality.
 *  - Both parseable: equal iff same canonical unit AND magnitudes within epsilon.
 *  - Otherwise: fall back to normalized-text equality (and the caller records a
 *    blind spot for the unparseable side).
 */
export function dosesMatch(a: CanonicalDose, b: CanonicalDose): boolean {
  if (a.parseable && b.parseable) {
    if (a.canonicalUnit !== b.canonicalUnit) return false
    if (a.value == null || b.value == null) return false
    const scale = Math.max(1, Math.abs(a.value), Math.abs(b.value))
    return Math.abs(a.value - b.value) <= DOSE_EPSILON * scale
  }
  return a.normalizedText === b.normalizedText
}

// ── 2. Drug-name alias resolution ───────────────────────────────────────────
//
// Strategy: lowercase, strip punctuation, collapse whitespace, then iteratively
// strip trailing salt / ester / hydrate tokens so that "Metformin HCl" and
// "Metformin hydrochloride" both resolve to "metformin". Stripping is
// conservative: it only removes a *trailing* salt token, never removes the last
// remaining token, and — critically — refuses to strip the anion off an
// electrolyte / mineral salt (see MINERAL_TOKENS below). For minerals the salt IS
// the product identity: "potassium chloride" and "potassium citrate" are DISTINCT
// medications, not two salt forms of "potassium". Whenever a strip does alter a
// name, the dropped tokens are returned so the scorer can surface it as a blind
// spot (a genuinely distinct salt could be masked).

// Electrolyte / mineral cations whose anion is part of the drug identity. When
// stripping a trailing salt token would expose a bare mineral cation, we stop —
// otherwise "potassium chloride", "potassium citrate", "magnesium sulfate" would
// all collapse to their cation and produce systematic false name-matches.
const MINERAL_TOKENS = new Set([
  'sodium',
  'potassium',
  'calcium',
  'magnesium',
  'lithium',
  'zinc',
  'iron',
  'ferrous',
  'ferric',
  'aluminum',
  'aluminium',
  'ammonium',
])

const SALT_TOKENS = new Set([
  'hcl',
  'hydrochloride',
  'hydrobromide',
  'hbr',
  'sodium',
  'potassium',
  'calcium',
  'magnesium',
  'sulfate',
  'sulphate',
  'succinate',
  'tartrate',
  'bitartrate',
  'maleate',
  'mesylate',
  'besylate',
  'fumarate',
  'citrate',
  'acetate',
  'phosphate',
  'nitrate',
  'bromide',
  'chloride',
  'base',
  'monohydrate',
  'dihydrate',
  'hemihydrate',
  'anhydrous',
  'micronized',
])

export interface NameResolution {
  /** Canonical name (lowercased, punctuation-collapsed, salt-stripped). */
  canonical: string
  /**
   * Trailing salt / ester / hydrate tokens dropped during resolution, in original
   * order (empty when nothing was stripped). When non-empty the scorer surfaces a
   * blind spot: a genuinely distinct salt could have been masked.
   */
  strippedSalts: string[]
}

/**
 * Resolve a drug name to its canonical alias form, reporting any salt tokens
 * dropped along the way.
 *
 * Examples:
 *   "Metformin"               → { canonical: "metformin",          strippedSalts: [] }
 *   "Metformin HCl"           → { canonical: "metformin",          strippedSalts: ["hcl"] }
 *   "Metformin hydrochloride" → { canonical: "metformin",          strippedSalts: ["hydrochloride"] }
 *   "Amlodipine besylate"     → { canonical: "amlodipine",         strippedSalts: ["besylate"] }
 *   "Sodium"                  → { canonical: "sodium",             strippedSalts: [] }  // last token never stripped
 *   "Potassium chloride"      → { canonical: "potassium chloride", strippedSalts: [] }  // mineral salt preserved
 *   "Magnesium sulfate"       → { canonical: "magnesium sulfate",  strippedSalts: [] }  // mineral salt preserved
 */
export function resolveName(raw: string): NameResolution {
  // Lowercase, replace any non-alphanumeric run with a single space, collapse.
  let tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9µ]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (tokens.length === 0) return { canonical: '', strippedSalts: [] }

  // Iteratively drop trailing salt tokens, but always keep at least one token,
  // and never strip the anion off a bare mineral cation (mineral salts are
  // distinct products, not salt forms of an organic base).
  const stripped: string[] = []
  while (tokens.length > 1 && SALT_TOKENS.has(tokens[tokens.length - 1])) {
    const remaining = tokens.slice(0, -1)
    if (remaining.every((t) => MINERAL_TOKENS.has(t))) break
    stripped.unshift(tokens[tokens.length - 1])
    tokens = remaining
  }

  return { canonical: tokens.join(' '), strippedSalts: stripped }
}

/** Canonical name only (thin wrapper over {@link resolveName}). */
export function normalizeName(raw: string): string {
  return resolveName(raw).canonical
}

// ── 3. Duplicate-name collapse rule ─────────────────────────────────────────
//
// Within ONE list (expected or actual), entries are normalized then collapsed:
//
//   RULE: entries with the SAME normalized name AND the SAME canonical dose
//         collapse into a single entry (a true duplicate). Entries with the
//         same normalized name but DIFFERENT canonical dose are KEPT as
//         distinct entries — multiple strengths of one drug are clinically
//         valid — but the name is reported in `duplicateNameGroups` so the
//         human reviewer sees the multi-strength situation rather than having
//         it silently merged or silently dropped.

export interface NormalizedEntry {
  /** Canonical name (post alias-resolution). */
  name: string
  /** Canonical dose, or null when the entry carries no dose field. */
  dose: CanonicalDose | null
  /** Original name as authored, for human-readable diff output. */
  rawName: string
  /** Original dose as authored, or null. */
  rawDose: string | null
  /** Salt tokens dropped from `rawName` during normalization (empty if none). */
  strippedSalts: string[]
}

export interface RawEntry {
  name: string
  dose?: string | null
}

function doseKey(dose: CanonicalDose | null): string {
  if (dose == null) return '∅'
  if (dose.parseable) return `${dose.canonicalUnit}:${dose.value}`
  return `text:${dose.normalizedText}`
}

export interface CollapseResult {
  entries: NormalizedEntry[]
  /** Normalized names that appeared with >1 distinct strength (kept, not merged). */
  duplicateNameGroups: string[]
}

/**
 * Normalize then collapse a list of raw entries per the duplicate-name rule.
 */
export function collapseDuplicates(raw: RawEntry[]): CollapseResult {
  const normalized: NormalizedEntry[] = raw.map((r) => {
    const res = resolveName(r.name)
    return {
      name: res.canonical,
      dose: r.dose != null && r.dose !== '' ? canonicalizeDose(r.dose) : null,
      rawName: r.name,
      rawDose: r.dose != null && r.dose !== '' ? r.dose : null,
      strippedSalts: res.strippedSalts,
    }
  })

  const seen = new Set<string>()
  const byName = new Map<string, Set<string>>()
  const entries: NormalizedEntry[] = []

  for (const e of normalized) {
    const dk = doseKey(e.dose)
    const fullKey = `${e.name}|${dk}`
    if (!byName.has(e.name)) byName.set(e.name, new Set())
    byName.get(e.name)!.add(dk)

    if (seen.has(fullKey)) continue // true duplicate (same name + same dose) → collapse
    seen.add(fullKey)
    entries.push(e)
  }

  const duplicateNameGroups = [...byName.entries()]
    .filter(([, doses]) => doses.size > 1)
    .map(([name]) => name)

  return { entries, duplicateNameGroups }
}
