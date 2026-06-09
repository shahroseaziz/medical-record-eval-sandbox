import type { EvalCase, StructuredDiffResult, StructuredFieldDiff } from '../types'
import {
  collapseDuplicates,
  dosesMatch,
  type CanonicalDose,
  type NormalizedEntry,
  type RawEntry,
} from './structured-diff-normalization'

/**
 * Structured-diff scorer — a deterministic, client-side (free), field-by-field
 * reference comparison of a structured medication list against a hand-authored
 * expected list.
 *
 * This is NOT the `contains` scorer. `contains` is set-membership over a flat
 * string ("is each expected token somewhere in the output?"). This scorer
 * aligns items by canonical name and then diffs each FIELD ({ name, dose }),
 * producing match / mismatch / missing (false-negative) / extra (false-positive)
 * semantics — the prototype's per-field `{ name, dose }` compare.
 *
 * Inputs:
 *   - `evalCase.expectedStructured` — the hand-authored expected output.
 *   - `actual` — the model's structured output (already parsed). When omitted,
 *     the scorer attempts to JSON.parse `evalCase.output`.
 *
 * Both sides are run through the normalization contract
 * (`structured-diff-normalization.ts`) before diffing: dose unit
 * canonicalization, drug-name alias resolution, duplicate-name collapse.
 *
 * Score = F1 over field-level matches, so it is penalized symmetrically by both
 * missed expected fields (recall) and spurious extra fields (precision).
 */
export function scoreStructuredDiff(evalCase: EvalCase, actual?: unknown): StructuredDiffResult {
  const blank = (msg: string): StructuredDiffResult => ({
    scorer: 'structured-diff',
    score: null,
    errored: true,
    errorMessage: msg,
    fields: [],
    matchCount: 0,
    mismatchCount: 0,
    missingCount: 0,
    extraCount: 0,
    precision: 0,
    recall: 0,
    blindSpots: [],
  })

  if (evalCase.expectedStructured == null) {
    return blank('No expectedStructured provided on case')
  }

  // Resolve the actual side: explicit arg wins; otherwise parse the output text.
  let actualValue = actual
  if (actualValue === undefined) {
    try {
      actualValue = JSON.parse(evalCase.output)
    } catch {
      return blank('actual output is not valid JSON and no parsed actual was supplied')
    }
  }

  const expectedRaw = extractEntries(evalCase.expectedStructured)
  const actualRaw = extractEntries(actualValue)

  // True-negative case: "patient has no meds." Expected is an empty list and the
  // model correctly produced an empty list — nothing to find, nothing spurious
  // produced, so F1 is vacuously perfect. This is a standard golden case and must
  // be scorable, not errored.
  if (expectedRaw.length === 0 && actualRaw.length === 0) {
    return {
      scorer: 'structured-diff',
      score: 1,
      fields: [],
      matchCount: 0,
      mismatchCount: 0,
      missingCount: 0,
      extraCount: 0,
      precision: 1,
      recall: 1,
      blindSpots: [
        'expected and actual are both empty (true-negative case): scored as a perfect match',
      ],
    }
  }

  const expected = collapseDuplicates(expectedRaw)
  const actualC = collapseDuplicates(actualRaw)

  const blindSpots: string[] = []
  for (const name of expected.duplicateNameGroups) {
    blindSpots.push(`expected lists "${name}" at multiple strengths (kept distinct, not merged)`)
  }
  for (const name of actualC.duplicateNameGroups) {
    blindSpots.push(`actual lists "${name}" at multiple strengths (kept distinct, not merged)`)
  }

  // Surface salt-stripping that ALTERED a name: a lexical strip can mask a
  // genuinely distinct salt, so a name "match" here is not guaranteed clinical
  // equality. Emitted per side; deduped below.
  for (const [side, c] of [
    ['expected', expected],
    ['actual', actualC],
  ] as const) {
    for (const e of c.entries) {
      if (e.strippedSalts.length > 0) {
        blindSpots.push(
          `${side} "${e.rawName}" salt-normalized to "${e.name}" (dropped ${e.strippedSalts
            .map((t) => `"${t}"`)
            .join(', ')}); a clinically distinct salt would be masked`,
        )
      }
    }
  }

  const fields = diffEntries(expected.entries, actualC.entries, blindSpots)

  let matchCount = 0
  let mismatchCount = 0
  let missingCount = 0
  let extraCount = 0
  for (const f of fields) {
    if (f.status === 'match') matchCount++
    else if (f.status === 'mismatch') mismatchCount++
    else if (f.status === 'missing') missingCount++
    else extraCount++
  }

  // F1 over field diffs. A mismatch is both a false positive (wrong value
  // produced) and a false negative (right value not produced).
  const tp = matchCount
  const fp = mismatchCount + extraCount
  const fn = mismatchCount + missingCount
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp)
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn)
  const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

  return {
    scorer: 'structured-diff',
    score,
    fields,
    matchCount,
    mismatchCount,
    missingCount,
    extraCount,
    precision,
    recall,
    // Dedupe: a normalization limitation may be hit on several entries but reads
    // as one blind spot for the reviewer.
    blindSpots: [...new Set(blindSpots)],
  }
}

// ── Entry extraction ─────────────────────────────────────────────────────────
//
// `expectedStructured` is a field→value object; the medication list may be the
// value of a `medications` (or `meds`) field, a bare array, or a single entry.
// Field names are matched leniently because hand-authored / model JSON varies.

const NAME_KEYS = ['name', 'medication', 'drug', 'med']
const DOSE_KEYS = ['dose', 'dosage', 'strength', 'amount']
const LIST_KEYS = ['medications', 'meds', 'medication', 'drugs', 'items', 'list']

function pickField(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of Object.keys(obj)) {
    if (keys.includes(k.toLowerCase())) {
      const v = obj[k]
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
    }
  }
  return null
}

function toEntry(item: unknown): RawEntry | null {
  if (typeof item === 'string') {
    return item.trim() ? { name: item } : null
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>
    const name = pickField(obj, NAME_KEYS)
    if (name == null || name.trim() === '') return null
    const dose = pickField(obj, DOSE_KEYS)
    return { name, dose: dose ?? undefined }
  }
  return null
}

/** Pull a flat list of `{ name, dose }` entries out of an arbitrary structured value. */
export function extractEntries(value: unknown): RawEntry[] {
  if (value == null) return []

  if (Array.isArray(value)) {
    return value.map(toEntry).filter((e): e is RawEntry => e !== null)
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>

    // 1. A recognized list field holding an array.
    for (const k of Object.keys(obj)) {
      if (LIST_KEYS.includes(k.toLowerCase()) && Array.isArray(obj[k])) {
        return (obj[k] as unknown[]).map(toEntry).filter((e): e is RawEntry => e !== null)
      }
    }

    // 2. Exactly one array-valued field → treat it as the list.
    const arrayFields = Object.keys(obj).filter((k) => Array.isArray(obj[k]))
    if (arrayFields.length === 1) {
      return (obj[arrayFields[0]] as unknown[])
        .map(toEntry)
        .filter((e): e is RawEntry => e !== null)
    }

    // 3. The object itself is a single entry.
    const single = toEntry(obj)
    return single ? [single] : []
  }

  return []
}

// ── Field-level diff ──────────────────────────────────────────────────────────

/**
 * Align expected vs actual entries by canonical name, then diff each field.
 *
 * Multiple entries sharing a name (distinct strengths) are paired greedily:
 * first exact dose matches, then leftovers paired by order as dose mismatches,
 * then any remaining expected → missing, remaining actual → extra.
 */
function diffEntries(
  expected: NormalizedEntry[],
  actual: NormalizedEntry[],
  blindSpots: string[],
): StructuredFieldDiff[] {
  const fields: StructuredFieldDiff[] = []

  const expByName = groupByName(expected)
  const actByName = groupByName(actual)
  // Preserve expected order, then append names that exist only in actual.
  const names: string[] = []
  for (const e of expected) if (!names.includes(e.name)) names.push(e.name)
  for (const a of actual) if (!names.includes(a.name)) names.push(a.name)

  for (const name of names) {
    const exps = [...(expByName.get(name) ?? [])]
    const acts = [...(actByName.get(name) ?? [])]
    const actUsed = new Array(acts.length).fill(false)
    const expUsed = new Array(exps.length).fill(false)

    // Pass 1 — exact (name + dose) matches.
    for (let i = 0; i < exps.length; i++) {
      const e = exps[i]
      for (let j = 0; j < acts.length; j++) {
        if (actUsed[j]) continue
        const a = acts[j]
        const bothNoDose = e.dose == null && a.dose == null
        const bothDose = e.dose != null && a.dose != null && dosesMatch(e.dose, a.dose)
        if (bothNoDose || bothDose) {
          fields.push({
            item: name,
            field: 'name',
            status: 'match',
            expected: e.rawName,
            actual: a.rawName,
          })
          if (e.dose != null && a.dose != null) {
            fields.push({
              item: name,
              field: 'dose',
              status: 'match',
              expected: e.dose.raw,
              actual: a.dose.raw,
            })
          }
          recordDoseBlindSpots(e.dose, a.dose, name, blindSpots)
          expUsed[i] = true
          actUsed[j] = true
          break
        }
      }
    }

    // Pass 2 — pair leftover expected/actual by order: name matches, dose differs.
    for (let i = 0; i < exps.length; i++) {
      if (expUsed[i]) continue
      const j = actUsed.findIndex((u) => !u)
      if (j === -1) break
      const e = exps[i]
      const a = acts[j]
      expUsed[i] = true
      actUsed[j] = true
      fields.push({
        item: name,
        field: 'name',
        status: 'match',
        expected: e.rawName,
        actual: a.rawName,
      })
      if (e.dose != null && a.dose != null) {
        fields.push({
          item: name,
          field: 'dose',
          status: 'mismatch',
          expected: e.dose.raw,
          actual: a.dose.raw,
        })
      } else if (e.dose != null) {
        fields.push({ item: name, field: 'dose', status: 'missing', expected: e.dose.raw })
      } else if (a.dose != null) {
        fields.push({ item: name, field: 'dose', status: 'extra', actual: a.dose.raw })
      }
      recordDoseBlindSpots(e.dose, a.dose, name, blindSpots)
    }

    // Pass 3 — leftover expected → missing (false negatives).
    for (let i = 0; i < exps.length; i++) {
      if (expUsed[i]) continue
      const e = exps[i]
      fields.push({ item: name, field: 'name', status: 'missing', expected: e.rawName })
      if (e.dose != null) {
        fields.push({ item: name, field: 'dose', status: 'missing', expected: e.dose.raw })
      }
    }

    // Leftover actual → extra (false positives).
    for (let j = 0; j < acts.length; j++) {
      if (actUsed[j]) continue
      const a = acts[j]
      fields.push({ item: name, field: 'name', status: 'extra', actual: a.rawName })
      if (a.dose != null) {
        fields.push({ item: name, field: 'dose', status: 'extra', actual: a.dose.raw })
      }
    }
  }

  return fields
}

function groupByName(entries: NormalizedEntry[]): Map<string, NormalizedEntry[]> {
  const m = new Map<string, NormalizedEntry[]>()
  for (const e of entries) {
    if (!m.has(e.name)) m.set(e.name, [])
    m.get(e.name)!.push(e)
  }
  return m
}

function recordDoseBlindSpots(
  e: CanonicalDose | null,
  a: CanonicalDose | null,
  name: string,
  blindSpots: string[],
): void {
  for (const [side, d] of [
    ['expected', e],
    ['actual', a],
  ] as const) {
    if (!d) continue
    // Compound / concentration units ("mg/mL"): each side of the slash is
    // alias-normalized but magnitudes are NOT converted across it, so
    // "10 mg/mL" vs "1 g/100mL" cannot be reconciled. Surface it whether the
    // dose parsed (matched per-side) or not.
    if (d.compound) {
      blindSpots.push(
        `${side} dose "${d.raw}" for "${name}" is a compound/concentration unit; magnitudes are not converted across the slash`,
      )
    }
    if (!d.parseable && !d.compound) {
      blindSpots.push(
        `${side} dose "${d.raw}" for "${name}" not parseable as value+unit; compared as text`,
      )
    }
  }
}
