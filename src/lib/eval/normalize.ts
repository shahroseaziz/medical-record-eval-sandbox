/**
 * Golden-diff normalization — the deterministic rules that decide every
 * golden-answer field verdict a user sees.
 *
 * Contract (see SHA-155 / the eval-playground REDESIGN-SPEC):
 *   1. Comparison is case-insensitive, whitespace-collapsed, and — for list
 *      values — order-independent.
 *   2. A clinical alias dictionary makes equivalent SIG / route / frequency
 *      phrasings compare equal ("QD" ≡ "once daily", "PO" ≡ "by mouth", …).
 *   3. A patient field PASSES iff the golden value matches the model value
 *      AFTER normalization. Fields absent from the golden are NOT graded.
 *
 * This module is deliberately NOT
 * `lib/eval/scorers/structured-diff-normalization.ts`. That module canonicalizes
 * *drug name + dose + unit* for the field-by-field structured-diff scorer. This
 * module canonicalizes *free-text patient-field values* (frequency, route, …) for
 * the golden-answer diff. Different scope; no shared code.
 *
 * PROVENANCE DISCIPLINE: every alias entry below carries a `source` citing a
 * standard prescription-abbreviation (SIG) / medical reference. Mappings are
 * never invented — a wrong alias is a silent user-facing false verdict. The
 * `source` field is enforced non-empty by the fixture table's unit tests.
 */

// ── Clinical alias dictionary ───────────────────────────────────────────────
//
// Each entry maps a canonical spelled-out phrase to its documented SIG / medical
// abbreviation variants. Variants are stored undotted and lowercase; dotted forms
// ("b.i.d.") are collapsed to the undotted key at lookup time, so listing the
// bare abbreviation ("bid") covers them. Canonical forms are themselves the
// spelled-out English so a value already written longhand normalizes to itself.

export interface AliasEntry {
  /** Canonical, spelled-out form every variant resolves to. */
  canonical: string
  /** Documented abbreviation variants (lowercase, undotted). */
  variants: string[]
  /**
   * PROVENANCE — the standard reference this mapping is drawn from. Never blank,
   * never invented. Asserted non-empty by the fixture-table tests.
   */
  source: string
}

const ALIAS_ENTRIES: AliasEntry[] = [
  // ── Frequency ──────────────────────────────────────────────────────────────
  {
    canonical: 'once daily',
    variants: ['qd', 'qday', 'od'],
    // Latin "quaque die" (every day). Standard SIG; ISMP "List of Error-Prone
    // Abbreviations" lists QD with intended meaning "once daily".
    source: 'SIG: Latin "quaque die" — ISMP List of Error-Prone Abbreviations',
  },
  {
    canonical: 'twice daily',
    variants: ['bid'],
    // Latin "bis in die" (twice a day). Standard SIG abbreviation.
    source: 'SIG: Latin "bis in die" — standard prescription abbreviation',
  },
  {
    canonical: 'three times daily',
    variants: ['tid'],
    // Latin "ter in die" (three times a day). Standard SIG abbreviation.
    source: 'SIG: Latin "ter in die" — standard prescription abbreviation',
  },
  {
    canonical: 'four times daily',
    variants: ['qid'],
    // Latin "quater in die" (four times a day). Standard SIG abbreviation.
    source: 'SIG: Latin "quater in die" — standard prescription abbreviation',
  },
  {
    canonical: 'every other day',
    variants: ['qod'],
    // Latin "quaque altera die" (every other day). Standard SIG; ISMP-flagged
    // but documented meaning is "every other day".
    source: 'SIG: Latin "quaque altera die" — ISMP List of Error-Prone Abbreviations',
  },
  {
    canonical: 'at bedtime',
    variants: ['hs', 'qhs'],
    // Latin "hora somni" (at the hour of sleep). Standard SIG abbreviation.
    source: 'SIG: Latin "hora somni" — standard prescription abbreviation',
  },
  {
    canonical: 'every morning',
    variants: ['qam', 'qm'],
    // Latin "quaque ante meridiem" (every morning). Standard SIG abbreviation.
    source: 'SIG: Latin "quaque ante meridiem" — standard prescription abbreviation',
  },
  {
    canonical: 'every evening',
    variants: ['qpm'],
    // Latin "quaque post meridiem" (every evening). Standard SIG abbreviation.
    source: 'SIG: Latin "quaque post meridiem" — standard prescription abbreviation',
  },
  {
    canonical: 'as needed',
    variants: ['prn'],
    // Latin "pro re nata" (as the situation arises). Standard SIG abbreviation.
    source: 'SIG: Latin "pro re nata" — standard prescription abbreviation',
  },
  {
    canonical: 'before meals',
    variants: ['ac'],
    // Latin "ante cibum" (before food). Standard SIG abbreviation.
    source: 'SIG: Latin "ante cibum" — standard prescription abbreviation',
  },
  {
    canonical: 'after meals',
    variants: ['pc'],
    // Latin "post cibum" (after food). Standard SIG abbreviation.
    source: 'SIG: Latin "post cibum" — standard prescription abbreviation',
  },
  {
    canonical: 'immediately',
    variants: ['stat'],
    // Latin "statim" (immediately). Standard SIG abbreviation.
    source: 'SIG: Latin "statim" — standard prescription abbreviation',
  },

  // ── Route of administration ──────────────────────────────────────────────────
  {
    canonical: 'by mouth',
    variants: ['po'],
    // Latin "per os" (through the mouth). Standard SIG route abbreviation.
    source: 'SIG/route: Latin "per os" — standard prescription abbreviation',
  },
  {
    canonical: 'by rectum',
    variants: ['pr'],
    // Latin "per rectum" (through the rectum). Standard SIG route abbreviation.
    source: 'SIG/route: Latin "per rectum" — standard prescription abbreviation',
  },
  {
    canonical: 'intravenous',
    variants: ['iv'],
    // "Intravenous" — standard route abbreviation (FDA/USP route nomenclature).
    source: 'Route: standard medical abbreviation for intravenous (USP route nomenclature)',
  },
  {
    canonical: 'intramuscular',
    variants: ['im'],
    // "Intramuscular" — standard route abbreviation (FDA/USP route nomenclature).
    source: 'Route: standard medical abbreviation for intramuscular (USP route nomenclature)',
  },
  {
    canonical: 'subcutaneous',
    variants: ['subq', 'subcut', 'sq', 'sc'],
    // "Subcutaneous" — standard route abbreviation. ISMP discourages SQ/SC as
    // error-prone but documents their intended meaning as subcutaneous.
    source: 'Route: standard medical abbreviation for subcutaneous — ISMP List of Error-Prone Abbreviations',
  },
  {
    canonical: 'sublingual',
    variants: ['sl'],
    // Latin "sub lingua" (under the tongue). Standard SIG route abbreviation.
    source: 'SIG/route: Latin "sub lingua" — standard prescription abbreviation',
  },
  {
    canonical: 'topical',
    variants: ['top'],
    // "Topical" — standard route abbreviation (USP route nomenclature).
    source: 'Route: standard medical abbreviation for topical (USP route nomenclature)',
  },
  {
    canonical: 'by inhalation',
    variants: ['inh'],
    // "Inhalation" — standard route abbreviation (USP route nomenclature).
    source: 'Route: standard medical abbreviation for inhalation (USP route nomenclature)',
  },
]

/**
 * Lookup table from a normalized variant key → canonical phrase. Built once.
 * A variant colliding across two canonicals would be a provenance bug, so the
 * builder throws on collision rather than silently picking a winner.
 */
const ALIAS_MAP: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const entry of ALIAS_ENTRIES) {
    for (const variant of entry.variants) {
      const key = collapseDottedAbbrev(variant.toLowerCase().trim())
      const existing = map.get(key)
      if (existing && existing !== entry.canonical) {
        throw new Error(
          `Alias collision: "${key}" maps to both "${existing}" and "${entry.canonical}"`,
        )
      }
      map.set(key, entry.canonical)
    }
  }
  return map
})()

/** Exposed for the fixture-table tests (provenance assertions). */
export function aliasEntries(): readonly AliasEntry[] {
  return ALIAS_ENTRIES
}

/**
 * Collapse a dotted abbreviation ("b.i.d.", "p.o.") to its undotted key ("bid",
 * "po"). Only applied when the token is letters separated by periods — never to
 * numerics like "0.5", which must keep their decimal point.
 */
function collapseDottedAbbrev(token: string): string {
  if (/^[a-zµ](\.[a-zµ])+\.?$/.test(token)) return token.replace(/\./g, '')
  return token
}

/**
 * Canonicalize a single whitespace-delimited token: strip surrounding
 * punctuation, collapse a dotted abbreviation, then resolve through the alias
 * dictionary. Unknown tokens are returned cleaned but otherwise unchanged.
 */
function canonicalizeToken(token: string): string {
  // Strip leading/trailing punctuation but keep internal characters (decimals,
  // slashes, dotted abbreviations).
  const trimmed = token.replace(/^[^a-z0-9µ%]+|[^a-z0-9µ%.]+$/g, '')
  if (trimmed === '') return ''
  const key = collapseDottedAbbrev(trimmed)
  const canonical = ALIAS_MAP.get(key)
  return canonical ?? trimmed
}

/**
 * Normalize a scalar patient-field value to its canonical comparison form:
 * lowercase, whitespace-collapsed, with every recognized SIG / route / frequency
 * abbreviation expanded to its canonical spelled-out phrase.
 *
 * Examples:
 *   "500 mg PO BID"  → "500 mg by mouth twice daily"
 *   "Once Daily"     → "once daily"
 *   "q.d."           → "once daily"
 */
export function normalizeValue(raw: string): string {
  const lowered = raw.toLowerCase().replace(/\s+/g, ' ').trim()
  if (lowered === '') return ''
  return lowered
    .split(' ')
    .map(canonicalizeToken)
    .filter((t) => t !== '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normalize a list value order-independently: each element is scalar-normalized,
 * then the list is sorted so element order does not affect equality. (A multiset
 * — duplicates are preserved, only order is discarded.)
 */
export function normalizeList(items: string[]): string[] {
  return items.map(normalizeValue).sort()
}

/** A gradeable patient-field value: a scalar or an (order-independent) list. */
export type FieldValue = string | string[]

/**
 * True iff the golden value matches the model value after normalization. Lists
 * compare order-independently; a scalar compared against a single-element list
 * is treated as that one-element list.
 */
export function valuesMatch(golden: FieldValue, model: FieldValue): boolean {
  const goldenIsList = Array.isArray(golden)
  const modelIsList = Array.isArray(model)

  if (goldenIsList || modelIsList) {
    const g = normalizeList(goldenIsList ? golden : [golden])
    const m = normalizeList(modelIsList ? model : [model])
    if (g.length !== m.length) return false
    return g.every((v, i) => v === m[i])
  }

  return normalizeValue(golden) === normalizeValue(model)
}

/** Verdict for one graded patient field. */
export interface FieldVerdict {
  field: string
  pass: boolean
  /** Normalized golden form actually compared (for human-readable diffs). */
  goldenNormalized: string
  /** Normalized model form actually compared, or null when the field was absent. */
  modelNormalized: string | null
}

function normalizedFormFor(value: FieldValue | undefined): string | null {
  if (value === undefined) return null
  return Array.isArray(value) ? normalizeList(value).join(' | ') : normalizeValue(value)
}

/**
 * Grade a model's patient record against the golden record.
 *
 * Only fields PRESENT in the golden are graded — fields absent from the golden
 * are not part of the contract and are skipped entirely. A golden field missing
 * from the model fails (the model omitted a required value).
 */
export function gradeFields(
  golden: Record<string, FieldValue>,
  model: Record<string, FieldValue>,
): FieldVerdict[] {
  const verdicts: FieldVerdict[] = []
  for (const field of Object.keys(golden)) {
    const goldenValue = golden[field]
    const hasModel = Object.prototype.hasOwnProperty.call(model, field)
    const modelValue = hasModel ? model[field] : undefined
    const pass = hasModel ? valuesMatch(goldenValue, modelValue as FieldValue) : false
    verdicts.push({
      field,
      pass,
      goldenNormalized: normalizedFormFor(goldenValue) ?? '',
      modelNormalized: normalizedFormFor(modelValue),
    })
  }
  return verdicts
}
