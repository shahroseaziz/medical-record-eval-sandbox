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

/**
 * One chunk row from `GET /api/patients/[id]/chunks` (N7b extends the SELECT to
 * carry `source_xml`). A section is split into multiple chunks when its narrative
 * exceeds the per-chunk char budget; every chunk of a section shares the same
 * `source_xml` (the verbatim <section>…</section> substring, nullable).
 */
export interface ChunkRow {
  section: string
  ord: number
  text: string
  source_xml: string | null
}

/** Response envelope of `GET /api/patients/[id]/chunks`. */
export interface ChunksResponse {
  chunks?: ChunkRow[]
  error?: string
}
