/**
 * Shared types for the Explore-the-data drawer (N7a shell + table, N7b detail).
 *
 * The row shape mirrors what `GET /api/patients?all=1` returns (added in N1):
 * the whole `summary` object plus the summary-v3 explorer fields surfaced at the
 * top level — `{ age, sex, conditionCount, medCount, chartBytes }`.
 */

export interface ExplorerPatient {
  id: string
  name: string
  /** Whole summary blob (demographics + sections + v3 fields); detail uses it in N7b. */
  summary: unknown
  age: number | null
  sex: string
  conditionCount: number
  medCount: number
  chartBytes: number
}

/** Response envelope of `GET /api/patients?all=1`. */
export interface AllPatientsResponse {
  patients: ExplorerPatient[]
  count: number
}
