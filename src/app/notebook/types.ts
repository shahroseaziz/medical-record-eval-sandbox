// Shared notebook view types. A patient the prompt can run against, flattened
// from `GET /api/patients/sample` — it carries the assembled stuff-mode `record`
// (the run grounding) plus the light framing fields the chips show.
export interface NotebookPatient {
  id: string
  name: string
  /** Assembled stuff-mode record — the grounding sent to the model. */
  record: string
  /** Local margined token estimate of `record` (fail-closed, O1). */
  recordTokens: number
  age: number | null
  sex: string
  conditionCount: number
}
