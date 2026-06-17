// ── Golden-answer grading (N9) ───────────────────────────────────────────────
//
// CLIENT-SIDE, DETERMINISTIC grading of a model's JSON output against a
// user-authored golden answer. Every verdict flows through `lib/eval/normalize`
// (the shared SHA-155 normalization contract): case / whitespace / list-order
// folding plus the clinical alias dictionary ("QD" ≡ "once daily"). There is
// ZERO network and ZERO server state here — golden scoring never spends a
// metered call.
//
// Grading contract (mirrors normalize.gradeFields):
//   • Only fields PRESENT in the golden are graded — a partial golden grades
//     partially; fields the user omitted are not part of the contract.
//   • A patient PASSES iff every graded field matches after normalization.
//   • A golden field the model omitted FAILS (the model dropped a required value).

import { gradeFields, type FieldValue } from '@/lib/eval/normalize'

/** Per-patient golden grade outcome. */
export type GoldenState = 'empty' | 'invalid' | 'nooutput' | 'pass' | 'fail'

/** One field's expected-vs-got diff, shown when the "≠" chip expands. */
export interface GoldenFieldDiff {
  field: string
  pass: boolean
  /** Raw golden value, formatted for display (what the user wrote). */
  expected: string
  /** Raw model value, or "—" when the field was absent from the output. */
  got: string
}

export interface GoldenGrade {
  state: GoldenState
  /** Every graded field (golden ∩ contract), in golden order. */
  fields: GoldenFieldDiff[]
  /** The subset that failed — drives the "≠ field, field" chip. */
  fails: GoldenFieldDiff[]
  /** Human-readable reason for an `invalid` golden (a JSON parse error). */
  error?: string
}

/**
 * Tolerantly parse a JSON object out of free text. Returns null when the text is
 * not a JSON object. Handles a Markdown ```json fence and trailing prose by
 * falling back to the first `{` … last `}` slice.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const candidates: string[] = []
  // Strip a ```json … ``` (or bare ```) fence if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) candidates.push(fence[1].trim())
  candidates.push(trimmed)
  // Last resort: the widest brace-delimited slice.
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1))

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Coerce an arbitrary JSON value to the scalar/list shape `normalize` compares. */
function toFieldValue(v: unknown): FieldValue {
  if (Array.isArray(v)) return v.map(scalarString)
  return scalarString(v)
}

function scalarString(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/** Format a raw value for the expected/got diff columns. */
function formatRaw(v: unknown): string {
  if (v === undefined) return '—'
  if (Array.isArray(v)) return v.length ? v.map(scalarString).join(', ') : '[]'
  if (v === null) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * Grade one patient's golden answer against its model output. Pure and
 * deterministic — no side effects, no I/O.
 *
 * @param goldenText  the user's golden JSON (a textarea value)
 * @param output      the model's JSON output string (may be empty / not-yet-run)
 * @param outputReady true once the patient's run has completed (`status==='done'`)
 */
export function gradeGolden(
  goldenText: string,
  output: string | undefined,
  outputReady: boolean,
): GoldenGrade {
  if (!goldenText.trim()) return { state: 'empty', fields: [], fails: [] }

  const golden = parseJsonObject(goldenText)
  if (!golden) {
    return {
      state: 'invalid',
      fields: [],
      fails: [],
      error: 'This golden answer is not valid JSON yet.',
    }
  }

  // No output to grade against (not run, still streaming, or empty body).
  if (!outputReady || !output || !output.trim()) {
    return { state: 'nooutput', fields: [], fails: [] }
  }

  // An unparseable model output grades as all-fields-fail rather than crashing —
  // the diff then shows "—" for every got column.
  const model = parseJsonObject(output) ?? {}

  const goldenFV: Record<string, FieldValue> = {}
  for (const k of Object.keys(golden)) goldenFV[k] = toFieldValue(golden[k])
  const modelFV: Record<string, FieldValue> = {}
  for (const k of Object.keys(model)) modelFV[k] = toFieldValue(model[k])

  const verdicts = gradeFields(goldenFV, modelFV)
  const fields: GoldenFieldDiff[] = verdicts.map((v) => ({
    field: v.field,
    pass: v.pass,
    expected: formatRaw(golden[v.field]),
    got: Object.prototype.hasOwnProperty.call(model, v.field) ? formatRaw(model[v.field]) : '—',
  }))
  const fails = fields.filter((f) => !f.pass)
  return { state: fails.length ? 'fail' : 'pass', fields, fails }
}
