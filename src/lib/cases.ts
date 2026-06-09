import type { RunMode } from '@/app/api/run/types'
import type { FieldScorerMap } from '@/lib/eval/types'

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
