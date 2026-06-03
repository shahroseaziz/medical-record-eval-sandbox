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
