import type { RunMode } from '@/app/api/run/types'
import type {
  FieldScorerMap,
  FieldResult,
  FieldResultState,
  ScorerName,
  ExpectedField,
} from '@/lib/eval/types'
import type { RowResult } from '@/lib/eval/row-aggregate'

export interface SeededCase {
  id: string
  patientId: string
  query: string
  mode: RunMode
  referenceLabel: string
  requiredSections: string[]
  rationale: string
  expectedOutput?: string
  k?: number
  record?: string
}

// User-created case: no referenceLabel, requiredSections, or rationale.
// expectedOutput is optional — if absent, no contains check is run.
// These are stored in localStorage only and NEVER included in seeded aggregates.
export interface UserCase {
  id: string
  patientId: string
  query: string
  mode: RunMode
  expectedOutput?: string
  k?: number
  record?: string
  createdAt: number
}

const STORAGE_KEY = 'user_cases_v1'

export function loadUserCases(): UserCase[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as UserCase[]
  } catch {
    return []
  }
}

export function saveUserCase(uc: UserCase): void {
  if (typeof window === 'undefined') return
  const cases = loadUserCases()
  const idx = cases.findIndex((c) => c.id === uc.id)
  if (idx >= 0) {
    cases[idx] = uc
  } else {
    cases.push(uc)
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cases))
}

export function deleteUserCase(id: string): void {
  if (typeof window === 'undefined') return
  const cases = loadUserCases().filter((c) => c.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cases))
}

// ── UserCaseV2 ─────────────────────────────────────────────────────────────

export interface CapturedChunk {
  text: string
  section: string
  distance: number
  similarity: number
}

// Grounding the output was produced against — authoritative for scoring later.
export interface CapturedGrounding {
  mode: RunMode
  chunks?: CapturedChunk[]
  record?: string
}

export interface UserCaseV2Provenance {
  genPromptHash: string
  patientId: string
  ragMode: RunMode
  k?: number
}

export interface UserCaseV2 {
  id: string
  taskPrompt: string
  patientId: string
  ragMode: RunMode
  capturedOutput: string
  capturedGrounding: CapturedGrounding
  referenceOutput?: string
  intentLabel: 'pass' | 'fail'
  designedFailReason?: string
  provenance: UserCaseV2Provenance
  createdAt: number
}

// ── UserCaseV3 ─────────────────────────────────────────────────────────────
//
// Net-new (S16 declared v2 terminal). V3 is a superset of V2: it keeps every
// v2 field except `referenceOutput`, which is replaced by the explicit
// hand-authored expected-output fields below, plus a per-field scorer map.
//
//  - `expectedStructured` — hand-authored structured expected output (field→value).
//  - `expectedProse`      — hand-authored expected prose, authored from the patient
//                           summary. NOT named `summary`: that would collide with the
//                           `patients.summary` jsonb column read by /api/patients.
//  - `fieldScorers`       — maps each expected field to the scorer that grades it.

export interface UserCaseV3 {
  /** Schema discriminator; always 3 for this shape. */
  version: 3
  id: string
  taskPrompt: string
  patientId: string
  ragMode: RunMode
  capturedOutput: string
  capturedGrounding: CapturedGrounding
  expectedStructured?: Record<string, unknown>
  expectedProse?: string
  fieldScorers: FieldScorerMap
  intentLabel: 'pass' | 'fail'
  designedFailReason?: string
  provenance: UserCaseV2Provenance
  createdAt: number
}

// ── localStorage keys ──────────────────────────────────────────────────────

const STORAGE_KEY_V2 = 'user_cases_v2'
const STORAGE_KEY_V3 = 'user_cases_v3'
const STORAGE_KEY_GEN_PROMPT = 'gen_prompt_v1'
const STORAGE_KEY_JUDGE_RUBRIC = 'judge_rubric_v1'

// ── Hash helpers ───────────────────────────────────────────────────────────

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// FNV-1a 64-bit → 16-char hex; synchronous, deterministic, ~1.8×10¹⁹ values (negligible collision risk).
function fnv1a64(str: string): string {
  let h = BigInt('0xcbf29ce484222325')
  const prime = BigInt('0x00000100000001b3')
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i))
    h = BigInt.asUintN(64, h * prime)
  }
  return h.toString(16).padStart(16, '0')
}

export function genPromptHash(prompt: string): string {
  return fnv1a64(normalizeWhitespace(prompt))
}

// A case is stale when the live gen-prompt hash differs from what was used to produce it.
// Accepts any case shape that carries provenance (v2 or v3).
export function isCaseStale(
  uc: { provenance: UserCaseV2Provenance },
  currentGenPrompt: string,
): boolean {
  return uc.provenance.genPromptHash !== genPromptHash(currentGenPrompt)
}

// ── Prompt persistence ─────────────────────────────────────────────────────

export function loadGenPrompt(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(STORAGE_KEY_GEN_PROMPT) ?? ''
}

export function saveGenPrompt(prompt: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY_GEN_PROMPT, prompt)
}

export function loadJudgeRubric(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem(STORAGE_KEY_JUDGE_RUBRIC) ?? ''
}

export function saveJudgeRubric(rubric: string): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY_JUDGE_RUBRIC, rubric)
}

// ── UserCaseV2 CRUD ────────────────────────────────────────────────────────

export function loadUserCasesV2(): UserCaseV2[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY_V2)
    if (!raw) return []
    return JSON.parse(raw) as UserCaseV2[]
  } catch {
    return []
  }
}

export function saveUserCaseV2(uc: UserCaseV2): void {
  if (typeof window === 'undefined') return
  const cases = loadUserCasesV2()
  const idx = cases.findIndex((c) => c.id === uc.id)
  if (idx >= 0) {
    cases[idx] = uc
  } else {
    cases.push(uc)
  }
  localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(cases))
}

export function deleteUserCaseV2(id: string): void {
  if (typeof window === 'undefined') return
  const cases = loadUserCasesV2().filter((c) => c.id !== id)
  localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(cases))
}

// ── UserCaseV2 → V3 migration ──────────────────────────────────────────────

// Pure, lossless migration of a single case. The v2 `referenceOutput` was the
// hand-authored ideal prose, so it carries over to `expectedProse`.
//
// The prose faithfulness scorer is only wired up when there is prose to grade:
// `referenceOutput` is optional in v2, and a case with none has no expected
// output, so it migrates to an empty `fieldScorers` map rather than a scorer
// pointed at an undefined field.
export function migrateUserCaseV2toV3(uc: UserCaseV2): UserCaseV3 {
  const expectedProse = uc.referenceOutput
  return {
    version: 3,
    id: uc.id,
    taskPrompt: uc.taskPrompt,
    patientId: uc.patientId,
    ragMode: uc.ragMode,
    capturedOutput: uc.capturedOutput,
    capturedGrounding: uc.capturedGrounding,
    expectedStructured: undefined,
    expectedProse,
    fieldScorers: expectedProse !== undefined ? { prose: 'faithfulness' } : {},
    intentLabel: uc.intentLabel,
    designedFailReason: uc.designedFailReason,
    provenance: uc.provenance,
    createdAt: uc.createdAt,
  }
}

export function migrateUserCasesV2toV3(cases: UserCaseV2[]): UserCaseV3[] {
  return cases.map(migrateUserCaseV2toV3)
}

// ── UserCaseV3 CRUD (canonical store, with v2→v3 migration bridge) ──────────

// v3 is the single canonical store for user cases — every reader and writer in
// the app goes through the V3 functions, so there is no split brain between
// stores. The v2 key is read-only legacy: it is migrated into v3 on first load
// and thereafter kept untouched as a backup.

// Reads the legacy v2 key and migrates it to v3. Returns [] if the key is
// absent, empty, corrupt, or not an array — never throws.
function migrateLegacyV2Store(): UserCaseV3[] {
  const rawV2 = localStorage.getItem(STORAGE_KEY_V2)
  if (!rawV2) return []
  try {
    const v2 = JSON.parse(rawV2) as UserCaseV2[]
    return Array.isArray(v2) ? migrateUserCasesV2toV3(v2) : []
  } catch {
    return []
  }
}

// Loads v3 cases. If no v3 store exists yet, the legacy v2 store is migrated and
// persisted under the v3 key (the v2 store is left untouched as a backup).
//
// If the v3 store is corrupt, we do NOT silently reset to empty: the v2 backup
// is deliberately preserved, so we recover from it and warn. The corrupt v3 blob
// is left in place — the recovered cases are re-persisted on the next save, so
// no good data is lost on the way through.
export function loadUserCasesV3(): UserCaseV3[] {
  if (typeof window === 'undefined') return []
  const rawV3 = localStorage.getItem(STORAGE_KEY_V3)
  if (rawV3) {
    try {
      const parsed = JSON.parse(rawV3)
      if (Array.isArray(parsed)) return parsed as UserCaseV3[]
      throw new Error('user_cases_v3 is not an array')
    } catch (err) {
      console.warn(
        '[cases] user_cases_v3 is corrupt — recovering from the user_cases_v2 backup.',
        err,
      )
      return migrateLegacyV2Store()
    }
  }
  // No v3 store yet — perform the one-time v2→v3 migration and persist it.
  const migrated = migrateLegacyV2Store()
  if (migrated.length > 0) {
    localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(migrated))
  }
  return migrated
}

// Overwrites the entire v3 store. Used by "reset to example", which replaces all
// cases at once. Encapsulates the storage key so callers never touch it directly.
export function replaceUserCasesV3(cases: UserCaseV3[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(cases))
}

export function saveUserCaseV3(uc: UserCaseV3): void {
  if (typeof window === 'undefined') return
  const cases = loadUserCasesV3()
  const idx = cases.findIndex((c) => c.id === uc.id)
  if (idx >= 0) {
    cases[idx] = uc
  } else {
    cases.push(uc)
  }
  localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(cases))
}

export function deleteUserCaseV3(id: string): void {
  if (typeof window === 'undefined') return
  const cases = loadUserCasesV3().filter((c) => c.id !== id)
  localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(cases))
}

// ── Account-portable state blob ────────────────────────────────────────────
/*
 * Portable, no localStorage-specific keys; importable on any account. The blob
 * tracks the canonical store, so it carries v3 cases:
 * {
 *   version: 2,             // schema version for forward-compat guards
 *   genPrompt: string,      // gen_prompt_v1
 *   judgeRubric: string,    // judge_rubric_v1
 *   cases: UserCaseV3[],    // user_cases_v3
 * }
 *
 * Legacy version-1 blobs carried v2-shaped cases; they are still importable and
 * are migrated to v3 on the way in.
 */
interface StateBlobV1 {
  version: 1
  genPrompt: string
  judgeRubric: string
  cases: UserCaseV2[]
}
interface StateBlobV2 {
  version: 2
  genPrompt: string
  judgeRubric: string
  cases: UserCaseV3[]
}

export function serializeState(): string {
  const blob: StateBlobV2 = {
    version: 2,
    genPrompt: loadGenPrompt(),
    judgeRubric: loadJudgeRubric(),
    cases: loadUserCasesV3(),
  }
  return JSON.stringify(blob)
}

export function deserializeState(json: string): void {
  if (typeof window === 'undefined') return
  let blob: StateBlobV1 | StateBlobV2
  try {
    blob = JSON.parse(json) as StateBlobV1 | StateBlobV2
  } catch {
    throw new Error('deserializeState: invalid JSON')
  }
  const version: number = blob.version
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported state blob version: ${version}`)
  }
  // Guard each field: absent or wrong-type fields fall back to safe defaults so
  // localStorage never receives the JS-coerced string "undefined".
  saveGenPrompt(typeof blob.genPrompt === 'string' ? blob.genPrompt : '')
  saveJudgeRubric(typeof blob.judgeRubric === 'string' ? blob.judgeRubric : '')
  const rawCases = Array.isArray(blob.cases) ? blob.cases : []
  // v1 blobs carry v2-shaped cases — migrate them; v2 blobs already carry v3.
  const v3Cases =
    blob.version === 1
      ? migrateUserCasesV2toV3(rawCases as UserCaseV2[])
      : (rawCases as UserCaseV3[])
  replaceUserCasesV3(v3Cases)
}

// ════════════════════════════════════════════════════════════════════════════
// Schema v4 — BenchSet / BenchCaseV4 / BenchRun (S21)
//
// Authoritative shape: arch-system.md §"Bench storage schema (S21)". One store
// (collapses "My Cases" + golden-set builder), single localStorage blob,
// account-portable (S16 discipline). Outputs move OUT of the case into runs
// (E27); the G5 agreement labels live ONCE in `BenchSet.labels` (E26) — the
// case-level `userLabel?` is that same store relocated, never a second copy.
// ════════════════════════════════════════════════════════════════════════════

/** The three scorers a v4 field can be graded by (S21 / E25). */
export type BenchFieldScorer = 'faithfulness' | 'reference-judge' | 'structured-diff'

/** One field-builder row (med family — drug/dose/route/status), S24. */
export interface BenchStructuredRow {
  drug: string
  dose: string
  route: string
  status: string
}

// BenchCaseV4 carries the SHIPPED v3 case's author-time fields and adds the
// field-builder structured rows + the v4 scorer map. Outputs (capturedOutput /
// capturedGrounding) and the intent label do NOT live here — they moved to
// `BenchRun.outputs` (E27) and `BenchSet.labels` (E26) respectively.
export interface BenchCaseV4 {
  /** Schema discriminator; always 4 for this shape. */
  version: 4
  id: string
  taskPrompt: string // user query
  patientId: string
  ragMode: RunMode
  expectedProse?: string // → reference-judge default (E25)
  expectedStructured?: BenchStructuredRow[] // field-builder rows (S24, med family)
  /** Per-field scorer assignment (derived + override, E25). */
  fieldScorers: Record<string, BenchFieldScorer>
  createdAt: number
}

/** One captured output within a run (selective-regen provenance, S23/E19). */
export interface BenchRunOutput {
  text: string
  /** The gen-prompt hash THIS output was generated under (S23). */
  genPromptHash: string
  /** S25 inBudget chunk set | stuff record, persisted at capture time (E19). */
  capturedGrounding: CapturedGrounding
}

export interface BenchRun {
  /**
   * The delta ANNOTATES on change (E27). Well-defined only when ALL outputs
   * share one hash; a mixed-prompt run suppresses the delta number (S23).
   */
  genPromptHash: string
  /** Hash of the judge VERDICT rubric (faithfulness path); constant for sets with no faithfulness case. */
  rubricHash: string
  /** LLM-judge pass threshold (default 0.85, E20-movable). Deterministic structured-diff (1.0) is threshold-invariant. */
  threshold: number
  /** Snapshot of each case's fieldScorers AT run time. */
  scorerAssignments: Record<string, Record<string, BenchFieldScorer>>
  outputs: Record<string, BenchRunOutput>
  /** RowAggregate = row-aggregate.ts `RowResult` (R6) over the per-field scorers. */
  scores: Record<string, RowResult>
  timestamp: number
}

export interface BenchSet {
  id: string
  name: string
  createdAt: number
  cases: BenchCaseV4[]
  /** G5 agreement labels — persist independently of runs (E26). */
  labels: Record<string, 'pass' | 'fail'>
  runs: { current: BenchRun | null; previous: BenchRun | null }
}

// The single store blob. Versioned for forward-compat guards; account-portable.
export interface BenchStoreV4 {
  version: 4
  sets: BenchSet[]
}

// ── localStorage keys (v4) ──────────────────────────────────────────────────

const STORAGE_KEY_BENCH_V4 = 'bench_sets_v4'
const STORAGE_KEY_MIGRATION_V4_DONE = 'migration_v4_done'
// The two legacy stores collapsed by the v4 store (design #8): the golden-set
// builder (`user_cases_v3`) and the "My Cases" key (`user_cases_v1`). Neither is
// ever deleted by the migration — they are read-only backups this cycle (D5).
const STORAGE_KEY_MY_CASES = STORAGE_KEY // 'user_cases_v1'

const MIGRATED_SET_ID = 'migrated-v4'
const MIGRATED_SET_NAME = 'Migrated'

// ── localStorage quota (pre-flight + QuotaExceededError handling) ────────────

// Conservative budget — the de-facto browser localStorage ceiling is ~5 MB per
// origin. The pre-flight check is advisory (it lets a fan-out refuse to start);
// the write guard is the hard backstop that turns a real QuotaExceededError into
// a typed, catchable failure instead of a silent partial write.
export const LOCALSTORAGE_BUDGET_BYTES = 5 * 1024 * 1024

// Thrown when a localStorage write is rejected for quota. setItem is atomic per
// key — on failure the PRIOR value is left intact, so a caught QuotaExceeded
// write means "completed work retained", never a silent partial blob.
export class BenchQuotaExceededError extends Error {
  readonly key: string
  constructor(key: string, cause?: unknown) {
    super(
      `localStorage quota exceeded writing "${key}". No data was written; the previous value is intact. Export to free space.`,
    )
    this.name = 'BenchQuotaExceededError'
    this.key = key
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}

// Browsers signal a full store with several distinct names/codes; match them all.
function isQuotaExceeded(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
    return (
      err.code === 22 || // most browsers
      err.code === 1014 || // Firefox legacy
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' // Firefox
    )
  }
  return err instanceof Error && err.name === 'QuotaExceededError'
}

// UTF-16 byte estimate (2 bytes/char) of the whole store — what the quota meters.
function localStorageBytes(): number {
  if (typeof window === 'undefined') return 0
  let total = 0
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key === null) continue
    const value = localStorage.getItem(key) ?? ''
    total += (key.length + value.length) * 2
  }
  return total
}

export interface QuotaPreflight {
  ok: boolean
  /** Store size, in bytes, if the write goes through. */
  projectedBytes: number
  budgetBytes: number
}

// Pre-flight size check — call BEFORE a fan-out begins, not only "on approach".
// Covers outputs AND capturedGrounding because both are inside the serialized
// blob. Pure read; never writes.
export function preflightQuota(key: string, value: string): QuotaPreflight {
  const existing = typeof window === 'undefined' ? null : localStorage.getItem(key)
  const existingBytes = existing === null ? 0 : (key.length + existing.length) * 2
  const incomingBytes = (key.length + value.length) * 2
  const projectedBytes = localStorageBytes() - existingBytes + incomingBytes
  return {
    ok: projectedBytes <= LOCALSTORAGE_BUDGET_BYTES,
    projectedBytes,
    budgetBytes: LOCALSTORAGE_BUDGET_BYTES,
  }
}

// Atomic, quota-guarded write. Throws BenchQuotaExceededError on a full store so
// the caller can retain completed work and prompt an export — never silent loss.
function writeWithQuotaGuard(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (err) {
    if (isQuotaExceeded(err)) throw new BenchQuotaExceededError(key, err)
    throw err
  }
}

// ── Canonical (stable) JSON — byte-identical round-trips ─────────────────────

// Recursively sort object keys so two structurally-equal stores serialize to
// byte-identical strings (Record key order is otherwise insertion-dependent).
// Arrays keep their order. Backs the round-trip + double-run idempotence proofs.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined) continue // JSON drops undefined; do it deterministically
      out[key] = canonicalize(v)
    }
    return out
  }
  return value
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

// ── BenchSet schema validation (named errors, never silent partial state) ────

// Carries the offending field so the UI can name exactly what was malformed.
export class BenchSetValidationError extends Error {
  readonly field: string
  constructor(field: string, detail: string) {
    super(`Invalid BenchSet: ${detail} (at \`${field}\`)`)
    this.name = 'BenchSetValidationError'
    this.field = field
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function describe(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function expectString(v: unknown, field: string): string {
  if (typeof v !== 'string')
    throw new BenchSetValidationError(field, `expected string, got ${describe(v)}`)
  return v
}

function expectNumber(v: unknown, field: string): number {
  if (typeof v !== 'number' || Number.isNaN(v))
    throw new BenchSetValidationError(field, `expected number, got ${describe(v)}`)
  return v
}

function validateFieldScorers(v: unknown, field: string): Record<string, BenchFieldScorer> {
  if (!isPlainObject(v))
    throw new BenchSetValidationError(field, `expected object, got ${describe(v)}`)
  const out: Record<string, BenchFieldScorer> = {}
  for (const [k, scorer] of Object.entries(v)) {
    if (scorer !== 'faithfulness' && scorer !== 'reference-judge' && scorer !== 'structured-diff')
      throw new BenchSetValidationError(`${field}.${k}`, `unknown scorer "${String(scorer)}"`)
    out[k] = scorer
  }
  return out
}

function validateBenchCase(v: unknown, field: string): BenchCaseV4 {
  if (!isPlainObject(v))
    throw new BenchSetValidationError(field, `expected object, got ${describe(v)}`)
  if (v.version !== 4)
    throw new BenchSetValidationError(`${field}.version`, `expected 4, got ${String(v.version)}`)
  let expectedStructured: BenchStructuredRow[] | undefined
  if (v.expectedStructured !== undefined) {
    if (!Array.isArray(v.expectedStructured))
      throw new BenchSetValidationError(
        `${field}.expectedStructured`,
        `expected array, got ${describe(v.expectedStructured)}`,
      )
    expectedStructured = v.expectedStructured.map((row, i) => {
      const rf = `${field}.expectedStructured[${i}]`
      if (!isPlainObject(row))
        throw new BenchSetValidationError(rf, `expected object, got ${describe(row)}`)
      return {
        drug: expectString(row.drug, `${rf}.drug`),
        dose: expectString(row.dose, `${rf}.dose`),
        route: expectString(row.route, `${rf}.route`),
        status: expectString(row.status, `${rf}.status`),
      }
    })
  }
  const ragMode = expectString(v.ragMode, `${field}.ragMode`)
  if (ragMode !== 'retrieve' && ragMode !== 'stuff')
    throw new BenchSetValidationError(
      `${field}.ragMode`,
      `expected "retrieve" | "stuff", got "${ragMode}"`,
    )
  return {
    version: 4,
    id: expectString(v.id, `${field}.id`),
    taskPrompt: expectString(v.taskPrompt, `${field}.taskPrompt`),
    patientId: expectString(v.patientId, `${field}.patientId`),
    ragMode,
    expectedProse:
      v.expectedProse === undefined
        ? undefined
        : expectString(v.expectedProse, `${field}.expectedProse`),
    expectedStructured,
    fieldScorers: validateFieldScorers(v.fieldScorers, `${field}.fieldScorers`),
    createdAt: expectNumber(v.createdAt, `${field}.createdAt`),
  }
}

// Scorer / state vocabularies (from @/lib/eval/types) — kept here so a malformed
// run is rejected with a named error instead of cast straight into the store.
const SCORER_NAMES = new Set<string>([
  'contains',
  'faithfulness',
  'extraction-completeness',
  'section-hit',
  'structured-diff',
  'reference-judge',
])
const FIELD_RESULT_STATES = new Set<string>([
  'matched',
  'mismatched',
  'judge-errored',
  'rate-limited',
  'skipped',
])
const EXPECTED_FIELDS = new Set<string>(['structured', 'prose'])

// number | null (a scoreable field carries a number; a non-scoreable one null).
function expectScore(v: unknown, field: string): number | null {
  if (v === null) return null
  return expectNumber(v, field)
}

function expectBoolean(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean')
    throw new BenchSetValidationError(field, `expected boolean, got ${describe(v)}`)
  return v
}

function expectFieldResultState(v: unknown, field: string): FieldResultState {
  const s = expectString(v, field)
  if (!FIELD_RESULT_STATES.has(s))
    throw new BenchSetValidationError(field, `unknown field-result state "${s}"`)
  return s as FieldResultState
}

function validateFieldResult(v: unknown, field: string): FieldResult {
  if (!isPlainObject(v))
    throw new BenchSetValidationError(field, `expected object, got ${describe(v)}`)
  const f = expectString(v.field, `${field}.field`)
  if (!EXPECTED_FIELDS.has(f))
    throw new BenchSetValidationError(`${field}.field`, `unknown expected field "${f}"`)
  const scorer = expectString(v.scorer, `${field}.scorer`)
  if (!SCORER_NAMES.has(scorer))
    throw new BenchSetValidationError(`${field}.scorer`, `unknown scorer "${scorer}"`)
  return {
    field: f as ExpectedField,
    scorer: scorer as ScorerName,
    score: expectScore(v.score, `${field}.score`),
    state: expectFieldResultState(v.state, `${field}.state`),
  }
}

// RowResult (row-aggregate.ts R6) — the per-case score record produced by a run.
function validateRowResult(v: unknown, field: string): RowResult {
  if (!isPlainObject(v))
    throw new BenchSetValidationError(field, `expected object, got ${describe(v)}`)
  if (!Array.isArray(v.fields))
    throw new BenchSetValidationError(
      `${field}.fields`,
      `expected array, got ${describe(v.fields)}`,
    )
  return {
    caseId: expectString(v.caseId, `${field}.caseId`),
    fields: v.fields.map((fr, i) => validateFieldResult(fr, `${field}.fields[${i}]`)),
    score: expectScore(v.score, `${field}.score`),
    state: expectFieldResultState(v.state, `${field}.state`),
    excluded: expectBoolean(v.excluded, `${field}.excluded`),
  }
}

// CapturedGrounding — the grounding an output was produced against (E19).
function validateCapturedGrounding(v: unknown, field: string): CapturedGrounding {
  if (!isPlainObject(v))
    throw new BenchSetValidationError(field, `expected object, got ${describe(v)}`)
  const mode = expectString(v.mode, `${field}.mode`)
  if (mode !== 'retrieve' && mode !== 'stuff')
    throw new BenchSetValidationError(
      `${field}.mode`,
      `expected "retrieve" | "stuff", got "${mode}"`,
    )
  let chunks: CapturedChunk[] | undefined
  if (v.chunks !== undefined) {
    if (!Array.isArray(v.chunks))
      throw new BenchSetValidationError(
        `${field}.chunks`,
        `expected array, got ${describe(v.chunks)}`,
      )
    chunks = v.chunks.map((c, i) => {
      const cf = `${field}.chunks[${i}]`
      if (!isPlainObject(c))
        throw new BenchSetValidationError(cf, `expected object, got ${describe(c)}`)
      return {
        text: expectString(c.text, `${cf}.text`),
        section: expectString(c.section, `${cf}.section`),
        distance: expectNumber(c.distance, `${cf}.distance`),
        similarity: expectNumber(c.similarity, `${cf}.similarity`),
      }
    })
  }
  return {
    mode,
    chunks,
    record: v.record === undefined ? undefined : expectString(v.record, `${field}.record`),
  }
}

function validateRun(v: unknown, field: string): BenchRun {
  if (!isPlainObject(v))
    throw new BenchSetValidationError(field, `expected object, got ${describe(v)}`)
  if (!isPlainObject(v.outputs))
    throw new BenchSetValidationError(
      `${field}.outputs`,
      `expected object, got ${describe(v.outputs)}`,
    )
  if (!isPlainObject(v.scores))
    throw new BenchSetValidationError(
      `${field}.scores`,
      `expected object, got ${describe(v.scores)}`,
    )
  if (!isPlainObject(v.scorerAssignments))
    throw new BenchSetValidationError(
      `${field}.scorerAssignments`,
      `expected object, got ${describe(v.scorerAssignments)}`,
    )
  const outputs: Record<string, BenchRunOutput> = {}
  for (const [caseId, out] of Object.entries(v.outputs)) {
    const of = `${field}.outputs.${caseId}`
    if (!isPlainObject(out))
      throw new BenchSetValidationError(of, `expected object, got ${describe(out)}`)
    outputs[caseId] = {
      text: expectString(out.text, `${of}.text`),
      genPromptHash: expectString(out.genPromptHash, `${of}.genPromptHash`),
      // Validated against the v4 schema (not cast) so malformed grounding is
      // rejected with a named error before it lands in the store.
      capturedGrounding: validateCapturedGrounding(
        out.capturedGrounding,
        `${of}.capturedGrounding`,
      ),
    }
  }
  const scorerAssignments: Record<string, Record<string, BenchFieldScorer>> = {}
  for (const [caseId, fs] of Object.entries(v.scorerAssignments)) {
    scorerAssignments[caseId] = validateFieldScorers(fs, `${field}.scorerAssignments.${caseId}`)
  }
  return {
    genPromptHash: expectString(v.genPromptHash, `${field}.genPromptHash`),
    rubricHash: expectString(v.rubricHash, `${field}.rubricHash`),
    threshold: expectNumber(v.threshold, `${field}.threshold`),
    scorerAssignments,
    outputs,
    // scores are RowResult records (row-aggregate); validated per-case, not cast.
    scores: Object.fromEntries(
      Object.entries(v.scores).map(([caseId, rr]) => [
        caseId,
        validateRowResult(rr, `${field}.scores.${caseId}`),
      ]),
    ),
    timestamp: expectNumber(v.timestamp, `${field}.timestamp`),
  }
}

function validateRunOrNull(v: unknown, field: string): BenchRun | null {
  return v === null || v === undefined ? null : validateRun(v, field)
}

// Validate an arbitrary parsed value as a BenchSet. Throws a named
// BenchSetValidationError on the first malformed field — never returns a partial.
export function validateBenchSet(v: unknown, field = '<root>'): BenchSet {
  if (!isPlainObject(v))
    throw new BenchSetValidationError(field, `expected object, got ${describe(v)}`)
  if (!Array.isArray(v.cases))
    throw new BenchSetValidationError(`${field}.cases`, `expected array, got ${describe(v.cases)}`)
  if (!isPlainObject(v.labels))
    throw new BenchSetValidationError(
      `${field}.labels`,
      `expected object, got ${describe(v.labels)}`,
    )
  if (!isPlainObject(v.runs))
    throw new BenchSetValidationError(`${field}.runs`, `expected object, got ${describe(v.runs)}`)
  const labels: Record<string, 'pass' | 'fail'> = {}
  for (const [caseId, label] of Object.entries(v.labels)) {
    if (label !== 'pass' && label !== 'fail')
      throw new BenchSetValidationError(
        `${field}.labels.${caseId}`,
        `expected "pass" | "fail", got "${String(label)}"`,
      )
    labels[caseId] = label
  }
  return {
    id: expectString(v.id, `${field}.id`),
    name: expectString(v.name, `${field}.name`),
    createdAt: expectNumber(v.createdAt, `${field}.createdAt`),
    cases: v.cases.map((c, i) => validateBenchCase(c, `${field}.cases[${i}]`)),
    labels,
    runs: {
      current: validateRunOrNull(
        (v.runs as Record<string, unknown>).current,
        `${field}.runs.current`,
      ),
      previous: validateRunOrNull(
        (v.runs as Record<string, unknown>).previous,
        `${field}.runs.previous`,
      ),
    },
  }
}

// ── JSON export / import (round-trip = identical set) ────────────────────────

// Export a single set to canonical JSON. Re-exporting an imported set yields a
// byte-identical string (stable key order), so export→import→export is a fixpoint.
export function exportBenchSet(set: BenchSet): string {
  return stableStringify(set)
}

// Import a single set from JSON. Validates against the v4 schema and throws a
// named BenchSetValidationError on malformed input — never a silent partial state.
export function importBenchSet(json: string): BenchSet {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new BenchSetValidationError('<root>', `not valid JSON — ${(err as Error).message}`)
  }
  return validateBenchSet(parsed)
}

// ── BenchSet store CRUD (single store) ───────────────────────────────────────

function emptyStore(): BenchStoreV4 {
  return { version: 4, sets: [] }
}

// Loads the v4 store. Corrupt blob → empty store (the legacy keys are untouched
// backups, so nothing is lost). Never throws.
export function loadBenchStore(): BenchStoreV4 {
  if (typeof window === 'undefined') return emptyStore()
  const raw = localStorage.getItem(STORAGE_KEY_BENCH_V4)
  if (!raw) return emptyStore()
  try {
    const parsed = JSON.parse(raw)
    if (!isPlainObject(parsed) || !Array.isArray(parsed.sets))
      throw new Error('bench_sets_v4 is malformed')
    return { version: 4, sets: parsed.sets.map((s, i) => validateBenchSet(s, `sets[${i}]`)) }
  } catch (err) {
    console.warn(
      '[cases] bench_sets_v4 is corrupt — starting from an empty store (legacy keys retained).',
      err,
    )
    return emptyStore()
  }
}

// Persists the store. Pre-flight quota check + atomic quota-guarded write: a full
// store throws BenchQuotaExceededError (caller retains completed work + prompts
// export), never a silent partial write.
export function saveBenchStore(store: BenchStoreV4): QuotaPreflight {
  if (typeof window === 'undefined')
    return { ok: true, projectedBytes: 0, budgetBytes: LOCALSTORAGE_BUDGET_BYTES }
  const serialized = stableStringify(store)
  const preflight = preflightQuota(STORAGE_KEY_BENCH_V4, serialized)
  writeWithQuotaGuard(STORAGE_KEY_BENCH_V4, serialized)
  return preflight
}

export function loadBenchSets(): BenchSet[] {
  return loadBenchStore().sets
}

export function getBenchSet(id: string): BenchSet | undefined {
  return loadBenchStore().sets.find((s) => s.id === id)
}

// Upsert a set by id.
export function saveBenchSet(set: BenchSet): QuotaPreflight {
  const store = loadBenchStore()
  const idx = store.sets.findIndex((s) => s.id === set.id)
  if (idx >= 0) store.sets[idx] = set
  else store.sets.push(set)
  return saveBenchStore(store)
}

export function deleteBenchSet(id: string): QuotaPreflight {
  const store = loadBenchStore()
  store.sets = store.sets.filter((s) => s.id !== id)
  return saveBenchStore(store)
}

// ── Legacy → v4 migration (D5; idempotent via flag + case-id dedup) ──────────

// Map a "My Cases" (user_cases_v1) row to a v4 case. The v1 query becomes the
// task prompt; expectedOutput becomes expected prose, graded by reference-judge
// (E25 default) when present.
function migrateV1CaseToV4(uc: UserCase): BenchCaseV4 {
  return {
    version: 4,
    id: uc.id,
    taskPrompt: uc.query,
    patientId: uc.patientId,
    ragMode: uc.mode,
    expectedProse: uc.expectedOutput,
    expectedStructured: undefined,
    fieldScorers: uc.expectedOutput !== undefined ? { prose: 'reference-judge' } : {},
    createdAt: uc.createdAt,
  }
}

// Map a golden-set-builder (user_cases_v3) case to a v4 case. The v3
// expectedStructured was a free Record (not the field-builder rows), so it is
// only carried when already row-shaped; otherwise dropped (the prose path, the
// common one, is preserved). v3 scorers outside the v4 union are dropped, but a
// graded prose field falls back to reference-judge so it stays graded.
function migrateV3CaseToV4(uc: UserCaseV3): BenchCaseV4 {
  const fieldScorers: Record<string, BenchFieldScorer> = {}
  for (const [fieldKey, scorer] of Object.entries(uc.fieldScorers)) {
    if (scorer === 'faithfulness' || scorer === 'reference-judge' || scorer === 'structured-diff')
      fieldScorers[fieldKey] = scorer
  }
  if (uc.expectedProse !== undefined && fieldScorers.prose === undefined)
    fieldScorers.prose = 'reference-judge'

  let expectedStructured: BenchStructuredRow[] | undefined
  const es = uc.expectedStructured
  if (Array.isArray(es)) {
    expectedStructured = es.filter(
      (r): r is BenchStructuredRow =>
        isPlainObject(r) &&
        typeof r.drug === 'string' &&
        typeof r.dose === 'string' &&
        typeof r.route === 'string' &&
        typeof r.status === 'string',
    )
    if (expectedStructured.length === 0) expectedStructured = undefined
  }

  return {
    version: 4,
    id: uc.id,
    taskPrompt: uc.taskPrompt,
    patientId: uc.patientId,
    ragMode: uc.ragMode,
    expectedProse: uc.expectedProse,
    expectedStructured,
    fieldScorers,
    createdAt: uc.createdAt,
  }
}

// Read both legacy stores raw (never throws; corrupt/absent → []).
function readLegacyV1Cases(): UserCase[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MY_CASES)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as UserCase[]) : []
  } catch {
    return []
  }
}

function readLegacyV3Cases(): UserCaseV3[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY_V3)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as UserCaseV3[]) : []
  } catch {
    return []
  }
}

export interface LegacyScan {
  v1Count: number
  v3Count: number
  total: number
  /** True when the one-time migration has already run (migration_v4_done flag). */
  done: boolean
}

// How many legacy cases are present, for the D5 banner ("Import N legacy cases").
export function scanLegacyCases(): LegacyScan {
  const done =
    typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY_MIGRATION_V4_DONE) === '1'
  const v1 = readLegacyV1Cases()
  const v3 = readLegacyV3Cases()
  return { v1Count: v1.length, v3Count: v3.length, total: v1.length + v3.length, done }
}

// Export-before-migrate escape hatch (D5 banner / S21 failure-mode table). Serializes
// the raw legacy stores verbatim — the user can save this BEFORE migrating, so the
// pre-v4 data is recoverable independently of the (non-destructive) localStorage keys.
export function exportLegacyCases(): string {
  return stableStringify({
    exportedFrom: 'legacy',
    schema: 'legacy-bench-export-v1',
    user_cases_v1: readLegacyV1Cases(),
    user_cases_v3: readLegacyV3Cases(),
  })
}

// Pure builder: legacy cases → the v4 cases for a "Migrated" set, deduped by id
// (v3 golden-set wins over a v1 "My Cases" row on an id collision). Exported for
// the migration-fixture tests.
export function buildMigratedCases(v1: UserCase[], v3: UserCaseV3[]): BenchCaseV4[] {
  const byId = new Map<string, BenchCaseV4>()
  for (const uc of v1) byId.set(uc.id, migrateV1CaseToV4(uc))
  for (const uc of v3) byId.set(uc.id, migrateV3CaseToV4(uc)) // v3 overrides v1 on id collision
  return [...byId.values()]
}

// The v3 `intentLabel` ('pass'/'fail') is the G5 agreement label; the v4 schema
// keeps it ONCE in `BenchSet.labels` (E26), so it relocates there rather than
// being dropped on migration. v1 "My Cases" rows carry no intent label. Exported
// for the migration-fixture tests (label carry-over). Deterministic → idempotent.
export function buildMigratedLabels(v3: UserCaseV3[]): Record<string, 'pass' | 'fail'> {
  const labels: Record<string, 'pass' | 'fail'> = {}
  for (const uc of v3) {
    if (uc.intentLabel === 'pass' || uc.intentLabel === 'fail') labels[uc.id] = uc.intentLabel
  }
  return labels
}

export interface MigrationResult {
  ran: boolean // false when the flag was already set (no-op)
  imported: number // cases added to the Migrated set THIS call
  set: BenchSet | null
}

// One-time, non-destructive legacy → v4 migration (D5). Idempotent two ways:
//   1. the migration_v4_done flag short-circuits a re-run, and
//   2. case-id dedup means even a forced re-run never duplicates a case.
// Legacy keys (user_cases_v1, user_cases_v3) are READ ONLY — never deleted.
// Export is offered by the UI before any destructive step; this function itself
// is non-destructive, so it is always safe to call.
export function migrateLegacyToV4(): MigrationResult {
  if (typeof window === 'undefined') return { ran: false, imported: 0, set: null }
  if (localStorage.getItem(STORAGE_KEY_MIGRATION_V4_DONE) === '1') {
    return { ran: false, imported: 0, set: getBenchSet(MIGRATED_SET_ID) ?? null }
  }

  const v3Legacy = readLegacyV3Cases()
  const migratedCases = buildMigratedCases(readLegacyV1Cases(), v3Legacy)
  const migratedLabels = buildMigratedLabels(v3Legacy)
  const store = loadBenchStore()
  let set = store.sets.find((s) => s.id === MIGRATED_SET_ID)
  if (!set) {
    set = {
      id: MIGRATED_SET_ID,
      name: MIGRATED_SET_NAME,
      // createdAt is derived from the legacy cases (deterministic — no Date.now),
      // so a re-run that rebuilds the set produces a byte-identical blob.
      createdAt: migratedCases.reduce(
        (min, c) => Math.min(min, c.createdAt),
        migratedCases[0]?.createdAt ?? 0,
      ),
      cases: [],
      labels: {},
      runs: { current: null, previous: null },
    }
    store.sets.push(set)
  }

  const existingIds = new Set(set.cases.map((c) => c.id))
  let imported = 0
  for (const c of migratedCases) {
    if (existingIds.has(c.id)) continue // case-id dedup → re-run is idempotent
    set.cases.push(c)
    existingIds.add(c.id)
    // Relocate the v3 intent label into BenchSet.labels (E26), once, alongside
    // its case. Guarded by the same dedup, so a forced re-run never rewrites it.
    if (migratedLabels[c.id] !== undefined) set.labels[c.id] = migratedLabels[c.id]
    imported++
  }

  saveBenchStore(store)
  localStorage.setItem(STORAGE_KEY_MIGRATION_V4_DONE, '1')
  return { ran: true, imported, set }
}

// ── Set-completion export prompt (design #9) ─────────────────────────────────

export interface SetCompletion {
  total: number
  /** Cases with a scored current run. */
  scored: number
  /** True when every case in the set has a current-run score — a completion moment. */
  complete: boolean
}

// A set is "complete" (an export-prompt moment) when it has cases and every case
// carries a score in the current run.
export function setCompletion(set: BenchSet): SetCompletion {
  const total = set.cases.length
  const scores = set.runs.current?.scores ?? {}
  const scored = set.cases.filter((c) => scores[c.id] !== undefined).length
  return { total, scored, complete: total > 0 && scored === total }
}

// ── Seeded aggregate (purity boundary) ────────────────────────────────────

// Pure function — no localStorage access. User cases in localStorage
// can never contaminate the seeded aggregate.
export function aggregateSeededCases(cases: SeededCase[]): {
  count: number
  ids: string[]
  modeBreakdown: { retrieve: number; stuff: number }
  withExpectedOutput: number
} {
  return {
    count: cases.length,
    ids: cases.map((c) => c.id),
    modeBreakdown: {
      retrieve: cases.filter((c) => c.mode === 'retrieve').length,
      stuff: cases.filter((c) => c.mode === 'stuff').length,
    },
    withExpectedOutput: cases.filter((c) => c.expectedOutput !== undefined).length,
  }
}
