// The worked-example prompt — shown as the prompt editor's placeholder and
// loaded verbatim by the "Load the worked example" affordance for a first-time
// user. A diabetes-management extraction over a synthetic chart: a concrete,
// gradeable task that the eval cells (later steps) can score against a golden
// answer. Mirrors design/reference/notebook (MRES_WORKED_PROMPT).
export const WORKED_PROMPT = `From this patient's chart, extract their diabetes management as JSON.

- a1c_current: most recent Hemoglobin A1c value
- a1c_date: the date of that result (YYYY-MM-DD)
- a1c_trend: "improving" | "stable" | "worsening" over the last year
- diabetes_meds: every current diabetes medication, with dose

Use only what is in the chart. If a field is absent, return null.`

// The worked-example judge criteria — shown as the LLM-judge criteria box's
// placeholder (SHA-162 N10). Plain-language acceptance criteria for the same
// diabetes-extraction task, written the way a clinician would describe a correct
// answer rather than as a schema. Mirrors design/reference/notebook
// (MRES_WORKED_CRITERIA).
export const WORKED_CRITERIA = `Pass if a1c_current matches the most recent A1c in the chart, a1c_trend reflects the last year of values, and diabetes_meds lists every current diabetes medication — no extras, none missing.`
