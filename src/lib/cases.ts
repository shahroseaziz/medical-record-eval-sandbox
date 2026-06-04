import type { RunMode } from '@/app/api/run/types'

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

// ── localStorage keys ──────────────────────────────────────────────────────

const STORAGE_KEY_V2 = 'user_cases_v2'
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
export function isCaseStale(uc: UserCaseV2, currentGenPrompt: string): boolean {
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

// ── Account-portable state blob ────────────────────────────────────────────
/*
 * Blob schema v1 — no localStorage-specific keys; importable on any account:
 * {
 *   version: 1,             // schema version for forward-compat guards
 *   genPrompt: string,      // gen_prompt_v1
 *   judgeRubric: string,    // judge_rubric_v1
 *   cases: UserCaseV2[],    // user_cases_v2
 * }
 */
interface StateBlob {
  version: 1
  genPrompt: string
  judgeRubric: string
  cases: UserCaseV2[]
}

export function serializeState(): string {
  const blob: StateBlob = {
    version: 1,
    genPrompt: loadGenPrompt(),
    judgeRubric: loadJudgeRubric(),
    cases: loadUserCasesV2(),
  }
  return JSON.stringify(blob)
}

export function deserializeState(json: string): void {
  if (typeof window === 'undefined') return
  let blob: StateBlob
  try {
    blob = JSON.parse(json) as StateBlob
  } catch {
    throw new Error('deserializeState: invalid JSON')
  }
  if (blob.version !== 1) throw new Error(`Unsupported state blob version: ${blob.version}`)
  // Guard each field: absent or wrong-type fields fall back to safe defaults so
  // localStorage never receives the JS-coerced string "undefined".
  saveGenPrompt(typeof blob.genPrompt === 'string' ? blob.genPrompt : '')
  saveJudgeRubric(typeof blob.judgeRubric === 'string' ? blob.judgeRubric : '')
  const cases = Array.isArray(blob.cases) ? blob.cases : []
  localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(cases))
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
