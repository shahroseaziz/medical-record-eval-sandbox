// ── Lesson → workbench carry-over ────────────────────────────────────────────
//
// R12 — the graduation wiring. When the learner finishes Beat 3 and crosses the
// graduation into the open bench, the state they left the lesson on must travel
// with them: the evaluator (faithfulness, the capstone's lens), the rubric
// (strict/lenient — whichever they last viewed), and any intent labels they
// flipped. The prototype dropped all of this and restarted the lesson; this
// module is the seam that carries it.
//
// The transport is the URL query string (the lesson page is statically rendered
// and the bench is a separate route, so there is no shared client state to hand
// off — a link is the handoff). Encoding is total and decoding is defensive:
// the query string is untrusted input (rule 18), so every field is validated
// against its known domain and anything unrecognized is dropped, never obeyed.

import { EVALUATORS, type EvaluatorType } from './bench'
import type { RubricVariant } from '@/lib/lesson/beat3'

const RUBRIC_VARIANTS: readonly RubricVariant[] = ['strict', 'lenient']
const INTENT_LABELS = ['pass', 'fail'] as const
type IntentLabel = (typeof INTENT_LABELS)[number]

/** Marker value identifying a bench load that came from the lesson graduation. */
export const CARRY_SOURCE = 'lesson'

/** The lesson state that travels to the bench. */
export interface LessonCarryState {
  evaluator: EvaluatorType
  rubric: RubricVariant
  /** Intent-label overrides keyed by case id (only the ones the learner flipped). */
  labels: Record<string, IntentLabel>
}

/** The validated, partial state decoded from a query string. */
export interface DecodedCarry {
  /** Whether the bench was opened from the lesson graduation (vs. a cold visit). */
  fromLesson: boolean
  evaluator?: EvaluatorType
  rubric?: RubricVariant
  labels: Record<string, IntentLabel>
}

// Case-id slug guard. The lesson's case ids are kebab slugs; reject anything else
// so a tampered query string cannot smuggle odd keys into the override map.
const CASE_ID_RE = /^[a-z0-9-]{1,64}$/
// Cap the number of label pairs honored — a defensive bound, not a real limit
// (the lesson has a handful of cases). Surfaced via decode dropping the excess.
const MAX_LABEL_PAIRS = 32

/**
 * Encode the lesson's last state into a query string the bench can decode. Total:
 * always produces a valid string. Pairs the evaluator and rubric directly and
 * serializes label overrides as `caseId:label` pairs.
 */
export function encodeCarryParams(state: LessonCarryState): string {
  const params = new URLSearchParams()
  params.set('from', CARRY_SOURCE)
  params.set('evaluator', state.evaluator)
  params.set('rubric', state.rubric)

  const pairs = Object.entries(state.labels)
    .filter(([id, label]) => CASE_ID_RE.test(id) && INTENT_LABELS.includes(label))
    .map(([id, label]) => `${id}:${label}`)
  if (pairs.length > 0) params.set('labels', pairs.join(','))

  return params.toString()
}

function firstValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/**
 * Decode and validate the carry-over state from Next's `searchParams` shape.
 * Defensive (rule 18): the query string is untrusted, so each field is checked
 * against its domain and dropped if invalid — never trusted blindly. Unknown
 * evaluators/rubrics fall back to undefined (the bench keeps its own default),
 * and malformed label pairs are skipped individually.
 */
export function decodeCarryParams(
  params: Record<string, string | string[] | undefined>,
): DecodedCarry {
  const fromLesson = firstValue(params.from) === CARRY_SOURCE

  const evRaw = firstValue(params.evaluator)
  const evaluator = (EVALUATORS as readonly string[]).includes(evRaw ?? '')
    ? (evRaw as EvaluatorType)
    : undefined

  const ruRaw = firstValue(params.rubric)
  const rubric = (RUBRIC_VARIANTS as readonly string[]).includes(ruRaw ?? '')
    ? (ruRaw as RubricVariant)
    : undefined

  const labels: Record<string, IntentLabel> = {}
  const labelsRaw = firstValue(params.labels)
  if (labelsRaw) {
    for (const pair of labelsRaw.split(',').slice(0, MAX_LABEL_PAIRS)) {
      const sep = pair.indexOf(':')
      if (sep <= 0) continue
      const id = pair.slice(0, sep)
      const label = pair.slice(sep + 1)
      if (CASE_ID_RE.test(id) && (label === 'pass' || label === 'fail')) {
        labels[id] = label
      }
    }
  }

  return { fromLesson, evaluator, rubric, labels }
}

/** Build the bench href that carries the lesson's last state. */
export function benchHrefFromLesson(state: LessonCarryState): string {
  return `/workbench?${encodeCarryParams(state)}`
}
