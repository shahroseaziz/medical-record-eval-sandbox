// The worked-example prompt — shown as the prompt editor's placeholder and
// loaded verbatim by the "Load the worked example" affordance for a first-time
// user. A diabetes-management extraction over a synthetic chart: a concrete,
// gradeable task that the eval cells (later steps) can score against a golden
// answer. Mirrors design/reference/notebook (MRES_WORKED_PROMPT).
export const WORKED_PROMPT = `From this patient's chart, extract their glucose management as JSON.

- glucose_current: the most recent blood glucose value, in mg/dL (number)
- glucose_date: the date of that most recent glucose result (YYYY-MM-DD)
- diabetes_meds: a JSON array of every current diabetes medication, with dose

Use only what is in the chart. If a field is absent, return null.`

// The worked-example judge criteria — shown as the LLM-judge criteria box's
// placeholder (SHA-162 N10). Plain-language acceptance criteria for the same
// diabetes-extraction task, written the way a clinician would describe a correct
// answer rather than as a schema. Mirrors design/reference/notebook
// (MRES_WORKED_CRITERIA).
export const WORKED_CRITERIA = `Pass if the summary states the patient's most recent blood glucose and describes the trend in their glucose over the last year, and names their current diabetes medication(s).`
