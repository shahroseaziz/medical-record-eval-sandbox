// ── Case composer — authoring logic (S24) ────────────────────────────────────
//
// The pure, offline core behind the add-case flow (the UI is CaseComposer.tsx).
// Everything here is deterministic and free (rule 20): the record-size guard, the
// scorer derivation (E25), the section-chip filter (D7), and the field-builder →
// structured-diff contract (D10 / R4). The one impure helper, `addCaseToAuthoredSet`,
// persists through the O2 BenchSet store.
//
// Decision inventory this module owns:
//   • D3  — random-N record-size guard. A sampled patient is eligible iff its
//           STUFF-mode record fits the 12k assembly budget (minus prompt/query
//           overhead) under O1's local token counter. ragMode is not authored at
//           sample time, so stuff-mode size is the binding constraint (retrieve
//           never overflows post-S25). The guard is what makes "give me N random"
//           hand out authorable skeletons, never dead-on-arrival ones.
//   • D7  — section-chip filter over EXISTING chunk-section metadata
//           (summary.sections). A pure list filter; no new index, schema, or
//           ingest change (the structural cut line — if it needed any of those
//           this would STOP and escalate, per Ground Rules).
//   • D10 — field-builder scope: medication-shaped rows (drug/dose/route/status;
//           drug+dose required). Other structured shapes author as prose/reference.
//   • E25 — derived-with-override scorer assignment: prose → reference-judge,
//           structured → structured-diff, none → faithfulness.

import type { RunMode } from '@/app/api/run/types'
import { estimateInputTokens, MAX_INPUT_TOKENS } from '@/lib/tokens'
import { scoreStructuredDiff } from '@/lib/eval/scorers/structured-diff'
import type { EvalCase, StructuredDiffResult } from '@/lib/eval/types'
import {
  type BenchCaseV4,
  type BenchFieldScorer,
  type BenchSet,
  type BenchStructuredRow,
  validateBenchCase,
  loadBenchStore,
  saveBenchSet,
} from '@/lib/cases'

// ── The 7 LOINC-coded C-CDA sections (existing chunk metadata) ───────────────
// Mirrors LOINC_TO_SECTION in `@/lib/ccda` — the section names that already live
// in `patients.summary.sections`. The chips are a filter over THIS vocabulary, so
// they introduce no new index (D7's structural cut line).
export const KNOWN_SECTIONS = [
  'problems',
  'medications',
  'allergies',
  'results',
  'encounters',
  'immunizations',
  'vitals',
] as const
export type SectionName = (typeof KNOWN_SECTIONS)[number]

// ── Record-size guard (D3) ───────────────────────────────────────────────────

/**
 * Tokens reserved out of the 12k input budget for everything that is NOT the
 * record itself: the system prompt, the QUESTION wrapper, and a typical authored
 * query. S25 frames the assembly budget as "12k minus prompt/query overhead"; a
 * patient is eligible only if its record leaves room for that overhead. Biased
 * generous (fail-closed) so a borderline patient is excluded rather than handed
 * out as a skeleton that overflows at run time.
 */
export const ASSEMBLY_OVERHEAD_TOKENS = 500

/** The token budget a sampled patient's stuff-mode record must fit within (D3). */
export const RECORD_BUDGET_TOKENS = MAX_INPUT_TOKENS - ASSEMBLY_OVERHEAD_TOKENS

/** One chunk of a patient's record (the shape the chunks API returns). */
export interface RecordChunk {
  section: string
  ord: number
  text: string
}

/**
 * Assemble a patient's chunks into the single stuff-mode record string — the same
 * `[section]\n{text}` join, `\n\n---\n\n`-separated, that the generation/score path
 * treats as the stuff-mode record. This is what the guard measures and what the
 * record view renders. Chunks are assumed pre-sorted (section, ord); we do not
 * reorder so the assembled record is stable.
 */
export function assembleStuffRecord(chunks: RecordChunk[]): string {
  return chunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
}

/**
 * The local (margined) token estimate of a stuff-mode record. Uses O1's
 * fail-closed `estimateInputTokens` — never the count_tokens API (S25: no
 * per-sample round-trip).
 */
export function recordTokenEstimate(record: string): number {
  return estimateInputTokens(record)
}

/**
 * The D3 guard: does this patient's stuff-mode record fit the assembly budget?
 * A `true` here is the contract behind "5 random → 5 authorable skeletons, none
 * dead-on-arrival" (modulo the documented local-approximation under-count slip,
 * which degrades to the S25/S23 refunded app-fault path at run time, not here).
 */
export function recordFitsBudget(record: string): boolean {
  return recordTokenEstimate(record) <= RECORD_BUDGET_TOKENS
}

/** Convenience: assemble + guard a patient's chunks in one call. */
export function patientRecordIsEligible(chunks: RecordChunk[]): boolean {
  return recordFitsBudget(assembleStuffRecord(chunks))
}

// ── Section-chip filter (D7) ─────────────────────────────────────────────────

/** The minimal patient shape the section-chip filter needs. */
export interface SectionFilterable {
  summary: { sections: string[] }
}

/**
 * Filter patients by selected section chips (D7). A patient matches when it has
 * EVERY selected section (intersection / "has all of"), so stacking chips narrows
 * the list — the natural read of "patients with an allergy AND a medication
 * section". An empty selection matches everyone. Pure; operates only over the
 * existing `summary.sections` metadata.
 */
export function filterBySections<T extends SectionFilterable>(
  patients: T[],
  selected: readonly string[],
): T[] {
  if (selected.length === 0) return patients
  return patients.filter((p) => {
    const have = new Set(p.summary.sections)
    return selected.every((s) => have.has(s))
  })
}

// ── Expected-output kinds + E25 scorer derivation ────────────────────────────

/**
 * The three-way expected-output authoring mode (S24):
 *   • prose      — a free-text reference answer (incl. an absence reference such
 *                  as "No cardiac procedures are documented").
 *   • structured — the med-family field builder (drug/dose/route/status).
 *   • none       — no answer key; graded by faithfulness against the record. The
 *                  absence-pattern hint lives on this mode in the UI.
 */
export type ExpectedKind = 'prose' | 'structured' | 'none'

/** The field key each expected kind grades under (stable, for the scorer chip). */
export const EXPECTED_FIELD_KEY: Record<ExpectedKind, string> = {
  prose: 'prose',
  structured: 'structured',
  none: 'claims',
}

/**
 * E25 — derive the per-field scorer from the expected-output kind:
 *   prose → reference-judge, structured → structured-diff, none → faithfulness.
 * This is the DEFAULT; the UI surfaces it as an editable chip (override visible),
 * so this function only produces the derived starting point.
 */
export function deriveScorer(kind: ExpectedKind): BenchFieldScorer {
  switch (kind) {
    case 'prose':
      return 'reference-judge'
    case 'structured':
      return 'structured-diff'
    case 'none':
      return 'faithfulness'
  }
}

/** The derived `fieldScorers` map for a given expected kind (E25). */
export function deriveFieldScorers(kind: ExpectedKind): Record<string, BenchFieldScorer> {
  return { [EXPECTED_FIELD_KEY[kind]]: deriveScorer(kind) }
}

// ── Field builder (D10) — med-family rows ────────────────────────────────────

/** A fresh, empty field-builder row. */
export function emptyStructuredRow(): BenchStructuredRow {
  return { drug: '', dose: '', route: '', status: '' }
}

/**
 * D10 requires drug + dose on every row (route/status optional). Returns the
 * indices of rows that are missing a required field, so the UI can flag exactly
 * which row is incomplete and the "add to set" action can gate on an empty array.
 */
export function incompleteStructuredRows(rows: BenchStructuredRow[]): number[] {
  const bad: number[] = []
  rows.forEach((r, i) => {
    if (r.drug.trim() === '' || r.dose.trim() === '') bad.push(i)
  })
  return bad
}

/** Drop fully-empty rows; trim survivors. Used before persisting the structured key. */
export function cleanStructuredRows(rows: BenchStructuredRow[]): BenchStructuredRow[] {
  return rows
    .map((r) => ({
      drug: r.drug.trim(),
      dose: r.dose.trim(),
      route: r.route.trim(),
      status: r.status.trim(),
    }))
    .filter((r) => r.drug !== '' || r.dose !== '' || r.route !== '' || r.status !== '')
}

/**
 * R4 contract — the field-builder rows ARE the structured-diff answer key. The
 * scorer's `extractEntries` reads `drug` as the name and `dose` as the dose (both
 * are in its NAME_KEYS / DOSE_KEYS vocabularies), so the rows can be fed straight
 * to `scoreStructuredDiff` as `expectedStructured`. This function makes that
 * contract explicit and is exercised by the R4 contract test: field-builder
 * output → a real (non-errored) structured-diff score.
 */
export function scoreStructuredAgainstRows(
  rows: BenchStructuredRow[],
  actual: unknown,
  query = 'structured-diff contract',
): StructuredDiffResult {
  const evalCase: EvalCase = {
    id: 'composer-contract',
    patientId: 'composer-contract',
    query,
    output: '',
    mode: 'stuff',
    // The rows array satisfies the scorer's array-of-entries input directly.
    expectedStructured: rows as unknown as Record<string, unknown>,
  }
  return scoreStructuredDiff(evalCase, actual)
}

// ── Skeleton case (the authorable starting point) ────────────────────────────

/** A budget-eligible patient a skeleton can be built from. */
export interface ComposablePatient {
  id: string
  name: string
  summary: { sections: string[]; demographics?: unknown }
}

/**
 * A sensible starter query so a fresh skeleton is immediately authorable rather
 * than blank — the med-extraction family is this cycle's structured target (D10),
 * so the default leans there. The author overwrites it freely.
 */
export const DEFAULT_TASK_PROMPT =
  "List the patient's active medications as a JSON array of { drug, dose, route, status }."

export interface SkeletonOptions {
  /** createdAt stamp — passed in (never Date.now here) so callers stay deterministic. */
  createdAt: number
  /** Override the default starter query. */
  taskPrompt?: string
  /** Stuff is the default; the guard measured the stuff record at sample time. */
  ragMode?: RunMode
  /** Stable id; callers pass a generated one. */
  id: string
}

/**
 * Build an authorable BenchCaseV4 skeleton for a guarded patient. "Authorable, not
 * dead-on-arrival" is enforced two ways: the patient is already budget-eligible
 * (the caller only offers guarded patients, D3), and the returned case is VALIDATED
 * against the v4 schema before it is returned — a skeleton that could not enter the
 * store is a bug, not a silent half-case. Defaults to the `none`/faithfulness path
 * (no answer key required to start grading), the cheapest authorable state.
 */
export function buildSkeletonCase(patient: ComposablePatient, opts: SkeletonOptions): BenchCaseV4 {
  const skeleton: BenchCaseV4 = {
    version: 4,
    id: opts.id,
    taskPrompt: opts.taskPrompt ?? DEFAULT_TASK_PROMPT,
    patientId: patient.id,
    ragMode: opts.ragMode ?? 'stuff',
    fieldScorers: deriveFieldScorers('none'),
    createdAt: opts.createdAt,
  }
  // Round-trips through the v4 validator so an unauthorable skeleton can never be
  // handed back (it would otherwise blow up the whole set on the next load).
  return validateBenchCase(skeleton, 'skeleton')
}

// ── Assemble an authored case from the composer's working state ───────────────

export interface ComposerDraft {
  id: string
  patientId: string
  taskPrompt: string
  ragMode: RunMode
  expectedKind: ExpectedKind
  expectedProse?: string
  structuredRows?: BenchStructuredRow[]
  /** The derived scorer, possibly overridden in the UI (E25 "override visible"). */
  scorerOverride?: BenchFieldScorer
  createdAt: number
}

/**
 * Project the composer's working draft into a validated BenchCaseV4. Applies the
 * E25 derivation (with the visible override), carries the prose/structured answer
 * key per the chosen kind, and validates before returning so a malformed draft is
 * rejected with a named BenchSetValidationError rather than persisted.
 */
export function draftToCase(draft: ComposerDraft): BenchCaseV4 {
  const scorer = draft.scorerOverride ?? deriveScorer(draft.expectedKind)
  const fieldScorers: Record<string, BenchFieldScorer> = {
    [EXPECTED_FIELD_KEY[draft.expectedKind]]: scorer,
  }

  let expectedProse: string | undefined
  let expectedStructured: BenchStructuredRow[] | undefined
  if (draft.expectedKind === 'prose') {
    const trimmed = draft.expectedProse?.trim()
    expectedProse = trimmed ? trimmed : undefined
  } else if (draft.expectedKind === 'structured') {
    const rows = cleanStructuredRows(draft.structuredRows ?? [])
    expectedStructured = rows.length > 0 ? rows : undefined
  }

  const built: BenchCaseV4 = {
    version: 4,
    id: draft.id,
    taskPrompt: draft.taskPrompt,
    patientId: draft.patientId,
    ragMode: draft.ragMode,
    expectedProse,
    expectedStructured,
    fieldScorers,
    createdAt: draft.createdAt,
  }
  return validateBenchCase(built, 'composer-draft')
}

// ── Persistence into the authored BenchSet (O2 store) ────────────────────────

export const AUTHORED_SET_ID = 'authored'
export const AUTHORED_SET_NAME = 'My cases'

/**
 * Persist an authored case into the "My cases" BenchSet, creating the set on first
 * add (account-portable single-blob discipline, S16/S21). Upsert-by-id so editing
 * a case replaces it rather than duplicating. Returns the updated set. Throws
 * BenchQuotaExceededError (from the store) if the write would exceed the quota —
 * never a silent partial write.
 */
export function addCaseToAuthoredSet(authored: BenchCaseV4): BenchSet {
  const store = loadBenchStore()
  let set = store.sets.find((s) => s.id === AUTHORED_SET_ID)
  if (!set) {
    set = {
      id: AUTHORED_SET_ID,
      name: AUTHORED_SET_NAME,
      createdAt: authored.createdAt,
      cases: [],
      labels: {},
      runs: { current: null, previous: null },
    }
  }
  const idx = set.cases.findIndex((c) => c.id === authored.id)
  if (idx >= 0) set.cases[idx] = authored
  else set.cases.push(authored)
  saveBenchSet(set)
  return set
}
