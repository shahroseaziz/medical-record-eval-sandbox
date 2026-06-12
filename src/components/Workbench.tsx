'use client'

import { useEffect, useMemo, useState } from 'react'
import { DisagreementTable } from './DisagreementTable'
import { EvaluatorResultsTable } from './EvaluatorResultsTable'
import { ClinicianAgreement } from './ClinicianAgreement'
import { BenchSetIO } from './BenchSetIO'
import { JudgeRubricEditor, DEFAULT_VERDICT_RUBRIC, type RescoreResult } from './JudgeRubricEditor'
import { saveBenchSet } from '@/lib/cases'
import { GenerationPromptEditor, DEFAULT_GENERATION_PROMPT } from './GenerationPromptEditor'
import { CaseComposer } from './CaseComposer'
import { RagInspector } from './RagInspector'
import { Term } from './Term'
import { useGenerationRun, type GenerationCase } from '@/hooks/useGenerationRun'
import { computeUserAgreement } from '@/lib/eval/user-agreement'
import {
  EVALUATORS,
  EVALUATOR_LABEL,
  evaluatorHasAnswerKey,
  loadBenchCases,
  assembleGrounding,
  buildBenchResults,
  buildStructuredDiffDetails,
  FALLBACK_THRESHOLDS,
  type EvaluatorType,
  type RubricVariant,
} from '@/lib/workbench/bench'
import type { Thresholds } from '@/lib/eval/thresholds'
import {
  genPromptHash,
  getBenchSet,
  type BenchCaseV4,
  type BenchFieldScorer,
  type BenchRunOutput,
} from '@/lib/cases'
import type { RowResult } from '@/lib/eval/row-aggregate'
import {
  WORKBENCH_SET_ID,
  WORKBENCH_SET_NAME,
  hashRubric,
  startRun,
  persistOutput,
  persistScore,
  currentOutputs,
  currentScores,
  currentLabels,
  persistLabel,
  clearLabel,
  type RunScorerAssignments,
} from '@/lib/workbench/run-model'
import { scoreRunCase } from '@/lib/workbench/run-scoring'
import { meteredCallsForCase, deterministicFirst, scoreSelectionSummary } from '@/lib/workbench/fanout'
import { computeRunDelta, deltaAnnotation, floorCaveat } from '@/lib/workbench/delta'
import styles from './Workbench.module.css'

// The active evaluator's field→scorer assignment, snapshotted into every run's
// E27 fingerprint (the axis that SUPPRESSES the O8 delta when it moves). Mirrors
// the per-field chips above, projected onto the v4 scorer vocabulary.
const EVALUATOR_ASSIGNMENT: Record<EvaluatorType, { field: string; scorer: BenchFieldScorer }> = {
  faithfulness: { field: 'claims', scorer: 'faithfulness' },
  'reference-judge': { field: 'prose', scorer: 'reference-judge' },
  'structured-diff': { field: 'structured', scorer: 'structured-diff' },
}

interface Props {
  /**
   * Per-scorer acceptance thresholds, read from config (evals/thresholds.yaml) on
   * the server and threaded in (rule 15). Falls back to the documented defaults
   * only when absent (e.g. isolated tests).
   */
  thresholds?: Thresholds
  /**
   * Initial knob state carried over from the lesson graduation (R12). When the
   * learner crosses the graduation, the bench opens on the surface they left —
   * the faithfulness evaluator, their rubric, and their labels — instead of a
   * cold default. Decoded from the URL by the page and threaded in here. Each
   * falls back to the bench's own default when absent (a cold visit).
   */
  initialEvaluator?: EvaluatorType
  initialRubric?: RubricVariant
  initialLabelOverrides?: Record<string, 'pass' | 'fail'>
}

const RUBRIC_LABEL: Record<RubricVariant, string> = {
  strict: 'Strict',
  lenient: 'Lenient',
}

/**
 * Evaluator palette metadata (R16). Each scorer carries a one-line "when to use"
 * and a cost note — the cost is the free-diff vs metered-judge distinction the
 * design reference surfaces on the palette chips and the results cost strip.
 * These are presentation labels over the existing eval semantics (bench.ts); they
 * do not change how anything is scored.
 */
const EVALUATOR_META: Record<EvaluatorType, { when: string; cost: string; metered: boolean }> = {
  faithfulness: {
    when: 'No expected answer — check the output against the source record.',
    cost: 'metered · tokens · must be calibrated',
    metered: true,
  },
  'reference-judge': {
    when: 'You have an expected answer, but it is fuzzy prose.',
    cost: 'metered · tokens · compares meaning',
    metered: true,
  },
  'structured-diff': {
    when: "Structured output where you know exactly what's right.",
    cost: 'free · instant',
    metered: false,
  },
}

/**
 * Per-field scorer chips (R16). The reference shows each schema field tagged with
 * its scorer (name·diff / dose·diff / freq·judge). The app's structured-diff key
 * grades these fields deterministically (a free diff); the prose evaluators grade
 * one fuzzy field with a metered judge. Informational chrome — it mirrors the real
 * scorer per evaluator, it does not introduce a per-field judge knob.
 */
const FIELD_SCORERS: Record<EvaluatorType, Array<{ field: string; scorer: 'diff' | 'judge' }>> = {
  'structured-diff': [
    { field: 'name', scorer: 'diff' },
    { field: 'dose', scorer: 'diff' },
  ],
  'reference-judge': [{ field: 'prose', scorer: 'judge' }],
  faithfulness: [{ field: 'claims', scorer: 'judge' }],
}

type BenchView = 'pipeline' | 'panels'

// ── Minimal inline icon set (the reference uses lucide-style glyphs) ──────────
type IconName = 'doc' | 'target' | 'flask' | 'arrow' | 'layers' | 'check' | 'bolt'
function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
  switch (name) {
    case 'doc':
      return (
        <svg {...common}>
          <path d="M14 3v4a1 1 0 0 0 1 1h4" />
          <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
          <path d="M9 9h1M9 13h6M9 17h6" />
        </svg>
      )
    case 'target':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="5" />
          <circle cx="12" cy="12" r="1" />
        </svg>
      )
    case 'flask':
      return (
        <svg {...common}>
          <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" />
          <path d="M7 14h10" />
        </svg>
      )
    case 'arrow':
      return (
        <svg {...common}>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      )
    case 'layers':
      return (
        <svg {...common}>
          <path d="M12 3 3 8l9 5 9-5-9-5Z" />
          <path d="M3 13l9 5 9-5M3 18l9 5 9-5" />
        </svg>
      )
    case 'check':
      return (
        <svg {...common}>
          <path d="M5 12l5 5L20 7" />
        </svg>
      )
    case 'bolt':
      return (
        <svg {...common}>
          <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
        </svg>
      )
  }
}

/**
 * The open workbench (R11, R16). Prompt, cases, and evaluator are free knobs and
 * the surface is never empty — it lands pre-loaded from the lesson's last state.
 *
 * Two presentations of the same live bench (R16):
 *  - Pipeline landing: the eval as three legible atoms (Prompt → Cases →
 *    Evaluator) flowing into a results badge. "Open the bench" expands into the
 *    three-panel daily driver. The atoms and the results are *already running* on
 *    landing (open without empty), so the panels stay mounted underneath — the
 *    pipeline is the headline, the bench is the body.
 *  - Panels: the dense three-panel layout with the reference atom chrome (mono
 *    "atom 1/2/3" eyebrows, panel headers, the evaluator palette as chips with
 *    when-to-use + cost, per-field scorer chips, the results grid + cost strip).
 *
 * Knobs (unchanged semantics — presentation only):
 *  - Evaluator (palette of 3): faithfulness reshapes the surface — no expected
 *    column, just grounding + claims + agreement.
 *  - Rubric (strict/lenient): the red-cell aha — the allergies case agrees strict,
 *    disagrees lenient.
 *  - Intent label: flip a case pass/fail and watch agreement move.
 *  - Generation prompt: the one LIVE knob (R1) — re-runs generation via /api/run.
 *
 * Everything except the prompt knob is deterministic and offline (rule 20).
 */
export function Workbench({
  thresholds = FALLBACK_THRESHOLDS,
  initialEvaluator,
  initialRubric,
  initialLabelOverrides,
}: Props) {
  const cases = useMemo(() => loadBenchCases(), [])
  const diffDetails = useMemo(() => buildStructuredDiffDetails(cases), [cases])

  // Seed the knobs from the lesson carry-over when present, else the cold default.
  const [evaluator, setEvaluator] = useState<EvaluatorType>(initialEvaluator ?? 'faithfulness')
  const [rubric, setRubric] = useState<RubricVariant>(initialRubric ?? 'strict')
  const [labelOverrides, setLabelOverrides] = useState<Record<string, 'pass' | 'fail'>>(
    initialLabelOverrides ?? {},
  )
  const [selectedCaseId, setSelectedCaseId] = useState<string>(cases[0]?.caseId ?? '')
  // O6b/S23: per-case selection for Generate/Score — no all-or-nothing fan-outs.
  // All checked by default (the pre-O6b behavior is the all-selected special case).
  const [checkedCaseIds, setCheckedCaseIds] = useState<ReadonlySet<string>>(
    () => new Set(cases.map((c) => c.caseId)),
  )
  // O12b parity port — the judge-calibration loop (the one loop that worked on
  // production pre-cycle, S26: ported, never regressed). Free-text verdict rubric +
  // single-case re-score PROBE: it re-judges the selected case's CURRENT output live
  // with the custom rubric and shows the result in the editor. It never mutates
  // persisted run scores — those stay on the default-rubric path so the E27
  // comparability fingerprint stays honest.
  const [judgeRubric, setJudgeRubric] = useState<string>(DEFAULT_VERDICT_RUBRIC)
  const [rescoring, setRescoring] = useState(false)
  const [rescoreResult, setRescoreResult] = useState<RescoreResult | null>(null)
  const [rescoreError, setRescoreError] = useState<string | null>(null)

  async function rescoreProbe() {
    if (rescoring) return
    const run = getBenchSet(WORKBENCH_SET_ID)?.runs.current
    const output = run?.outputs[selectedCaseId]
    const grounding = caseRecords.get(selectedCaseId) ?? ''
    if (!output || !grounding) {
      setRescoreError('Generate an output for the selected case first.')
      return
    }
    setRescoring(true)
    setRescoreError(null)
    try {
      const res = await fetch('/api/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'captured',
          capturedOutput: output.text,
          capturedGrounding: grounding,
          userVerdictRubric: judgeRubric,
        }),
      })
      if (!res.ok) throw new Error(res.status === 429 ? 'Rate-limited — try again when the window resets.' : `score failed (${res.status})`)
      setRescoreResult((await res.json()) as RescoreResult)
    } catch (err) {
      setRescoreError(err instanceof Error ? err.message : 'Re-score failed')
    } finally {
      setRescoring(false)
    }
  }

  function toggleChecked(caseId: string) {
    setCheckedCaseIds((prev) => {
      const next = new Set(prev)
      if (next.has(caseId)) next.delete(caseId)
      else next.add(caseId)
      return next
    })
  }
  const [generationPrompt, setGenerationPrompt] = useState(DEFAULT_GENERATION_PROMPT)

  // Land on the pipeline; "open the bench" expands to the panels (R16).
  const [view, setView] = useState<BenchView>('pipeline')

  // The add-case composer (S24) lives in the cases atom — toggled open, it walks
  // the author through the guarded picker → record → query → expected → derived
  // chips flow and persists into the "My cases" BenchSet (O2 store). The count of
  // authored cases is surfaced so the add lands as a visible consequence.
  const [composerOpen, setComposerOpen] = useState(false)
  const [authoredCount, setAuthoredCount] = useState(0)

  // RAG mode in the bench (O10 / G4). The retrieve-vs-stuff practice — chunk view,
  // distance/similarity, section_hit over the inBudget subset — lives in the cases
  // atom, toggled open. Deterministic and offline (rule 20); see RagInspector.
  const [ragOpen, setRagOpen] = useState(false)

  // The live generation fan-out (R1). Editing the prompt and regenerating re-runs
  // generation over every case — the keystone the prototype faked.
  const gen = useGenerationRun()

  // Reload survival (O7a): outputs persisted into runs.current.outputs on the
  // workbench BenchSet are rehydrated on mount, so a generated-but-unscored output
  // survives a page refresh (generation is the expensive half). The live `gen`
  // stream takes precedence; this is the fallback the inspector reads after a reload
  // before anything is regenerated again.
  const [restoredOutputs, setRestoredOutputs] = useState<Record<string, BenchRunOutput>>({})
  // Fresh per-case row scores for the CURRENT run (O7b). Scoring consumes
  // runs.current.outputs and writes runs.current.scores; this mirrors the persisted
  // scores for the surface and is rehydrated on mount so a reload restores both the
  // outputs the user generated AND the scores they ran (resume-scoring, S22).
  const [runScores, setRunScores] = useState<Record<string, RowResult>>({})
  // The G5 clinician labels (E26) — the user's pass/fail marks on scored outputs,
  // persisted in BenchSet.labels INDEPENDENTLY of runs. Rehydrated on mount so a
  // reload (or a baseline-vs-current swap) never discards them.
  const [userLabels, setUserLabels] = useState<Record<string, 'pass' | 'fail'>>({})
  useEffect(() => {
    setRestoredOutputs(currentOutputs(WORKBENCH_SET_ID))
    setRunScores(currentScores(WORKBENCH_SET_ID))
    setUserLabels(currentLabels(WORKBENCH_SET_ID))
  }, [])

  // A non-fatal note when a persist write is refused (quota). The completed in-memory
  // outputs are retained either way (S22) — the full quota-export prompt is O6.
  const [persistError, setPersistError] = useState<string | null>(null)

  // Scoring-pass state (O7b). `scoring` guards re-entry; `scoredCount`/`scoreTotal`
  // drive the progress line; `scoreRateLimited` offers resume; `scoreError` is a
  // non-fatal note. Scoring runs over the PERSISTED run (runs.current.outputs), so a
  // surviving (reloaded) set can be scored with no in-session generation.
  const [scoring, setScoring] = useState(false)
  const [scoredCount, setScoredCount] = useState(0)
  const [scoreTotal, setScoreTotal] = useState(0)
  const [scoreRateLimited, setScoreRateLimited] = useState(false)
  const [scoreError, setScoreError] = useState<string | null>(null)

  // Results recompute synchronously whenever the evaluator, rubric, or labels
  // change — that is "changing any knob re-runs" for the deterministic knobs.
  const results = useMemo(
    () => buildBenchResults(evaluator, cases, rubric, thresholds, labelOverrides),
    [evaluator, cases, rubric, thresholds, labelOverrides],
  )

  // The pass threshold for the active evaluator, read from config (rule 15) — the
  // SAME cutoff the results table classifies against, so the badge can never
  // contradict the table it summarizes. Faithfulness reads its slider's starting
  // value; the answer-key evaluators read frozen per-field state, so their config
  // threshold is the consistent reference point (caseVerdict ignores it for them).
  const evaluatorThreshold =
    evaluator === 'faithfulness'
      ? thresholds.faithfulness
      : evaluator === 'reference-judge'
        ? thresholds.referenceJudge
        : thresholds.structuredDiff

  // Aggregate agreement drives the pipeline's results badge — "the whole machine,
  // open" needs a live number on the landing, not a blank chip.
  const { agreement, n, agreeCount } = useMemo(
    () => computeUserAgreement(results, evaluatorThreshold),
    [results, evaluatorThreshold],
  )

  // The O8 iteration delta (E27 / G3): previous-vs-current verdict flips + aggregate
  // move, read from the live persisted set so it reflects the rotation that the next
  // regeneration performs (S22). Recomputes whenever a score lands or a regeneration
  // resets the run — both flow through runScores / restoredOutputs. The gen-prompt axis
  // ANNOTATES (a changed genPromptHash still renders the number); a mixed-prompt current
  // run or a moved rubric/threshold/scorer SUPPRESSES with its own banner (never conflated).
  const delta = useMemo(() => {
    const runs = getBenchSet(WORKBENCH_SET_ID)?.runs
    return computeRunDelta(runs?.previous, runs?.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runScores, restoredOutputs])

  const promptEdited = generationPrompt !== DEFAULT_GENERATION_PROMPT
  // Prompt edited but not yet regenerated → the deterministic results no longer
  // reflect the live prompt. Surface that, and offer the live re-run.
  const promptStale = promptEdited && gen.completed === 0 && !gen.running

  const selectedCase = cases.find((c) => c.caseId === selectedCaseId) ?? cases[0]

  function handleIntentLabelChange(caseId: string, label: 'pass' | 'fail') {
    setLabelOverrides((prev) => ({ ...prev, [caseId]: label }))
  }

  // Mark / clear a clinician label on a scored output (G5). Persists to
  // BenchSet.labels immediately (independent of runs), then mirrors into state.
  function handleUserLabel(caseId: string, label: 'pass' | 'fail') {
    try {
      const set = persistLabel(WORKBENCH_SET_ID, caseId, label)
      setUserLabels({ ...set.labels })
    } catch (err) {
      setPersistError(err instanceof Error ? err.message : 'Could not save label')
    }
  }
  function handleClearUserLabel(caseId: string) {
    try {
      const set = clearLabel(WORKBENCH_SET_ID, caseId)
      setUserLabels({ ...set.labels })
    } catch (err) {
      setPersistError(err instanceof Error ? err.message : 'Could not clear label')
    }
  }

  // Stuff mode: the committed grounding IS the record, so the live run grounds on
  // exactly what the offline surface showed. patientId is the synthetic case id
  // (stuff mode never touches the patient table for retrieval). The assembled record
  // is also the `capturedGrounding` persisted with each output (E19 — score against
  // the output's own context without a drift-prone re-fetch).
  const caseRecords = useMemo(
    () => new Map(cases.map((c) => [c.caseId, assembleGrounding(c.grounding)])),
    [cases],
  )

  function toGenerationCases(): GenerationCase[] {
    // Selected cases only (O6b) — generation books exactly what was checked.
    return cases.filter((c) => checkedCaseIds.has(c.caseId)).map((c) => ({
      id: c.caseId,
      patientId: c.caseId,
      query: c.taskPrompt,
      mode: 'stuff' as const,
      record: caseRecords.get(c.caseId) ?? '',
    }))
  }

  // Mirror the bench's golden set onto the v4 store as the run's cases, tagged with
  // the active evaluator's scorer so the persisted run is coherent and scorable (O7b).
  function toBenchCases(): BenchCaseV4[] {
    const { field, scorer } = EVALUATOR_ASSIGNMENT[evaluator]
    return cases.map((c) => ({
      version: 4 as const,
      id: c.caseId,
      taskPrompt: c.taskPrompt,
      patientId: c.caseId,
      ragMode: 'stuff' as const,
      expectedProse: c.expectedProse || undefined,
      fieldScorers: { [field]: scorer },
      createdAt: 0, // deterministic mirror stamp (the run carries the real timestamp)
    }))
  }

  // The E27 per-case scorer-assignment snapshot for the run fingerprint.
  function toScorerAssignments(): RunScorerAssignments {
    const { field, scorer } = EVALUATOR_ASSIGNMENT[evaluator]
    return Object.fromEntries(cases.map((c) => [c.caseId, { [field]: scorer }]))
  }

  // The persist-as-it-lands seam (O7a): each completed output is written straight
  // into runs.current.outputs and flushed to localStorage. genPromptHash is stamped
  // PER output (selective-regen provenance, S23); the run-level hash is derived from
  // the merged set. A quota refusal is caught — completed work is retained (S22).
  function persistGeneratedOutput(caseId: string, output: string) {
    const grounding: BenchRunOutput = {
      text: output,
      genPromptHash: genPromptHash(generationPrompt),
      capturedGrounding: { mode: 'stuff', record: caseRecords.get(caseId) ?? '' },
    }
    try {
      const set = persistOutput(WORKBENCH_SET_ID, caseId, grounding)
      setRestoredOutputs({ ...set.runs.current!.outputs })
    } catch (err) {
      setPersistError(err instanceof Error ? err.message : 'Could not persist output')
    }
  }

  function regenerate() {
    if (gen.running || scoring || checkedCaseIds.size === 0) return
    setPersistError(null)
    setScoreError(null)
    // Open a fresh run. startRun's rotation gate (S22) promotes a FULLY-scored prior
    // run into runs.previous (the new baseline) before dropping current; a partial /
    // unscored prior run does not rotate. Either way runs.previous (the last scored
    // baseline) is preserved. The fresh current has no scores yet, so clear the
    // surface scores — the new outputs must be re-scored (no display-only carry-over).
    try {
      startRun(WORKBENCH_SET_ID, {
        name: WORKBENCH_SET_NAME,
        cases: toBenchCases(),
        rubricHash: hashRubric(rubric),
        threshold: evaluatorThreshold,
        scorerAssignments: toScorerAssignments(),
        timestamp: Date.now(),
      })
      setRestoredOutputs({})
      setRunScores({})
      setScoredCount(0)
      setScoreTotal(0)
      setScoreRateLimited(false)
    } catch (err) {
      setPersistError(err instanceof Error ? err.message : 'Could not start run')
      return
    }
    gen.run(toGenerationCases(), generationPrompt, { onCaseDone: persistGeneratedOutput })
  }

  // Score the CURRENT run (O7b). Consumes runs.current.outputs (the freshly
  // regenerated text + its captured grounding) and writes runs.current.scores. Reads
  // the PERSISTED run, so it scores the surviving outputs after a reload too (S22
  // resume-scoring). Already-scored cases are skipped — a second pass resumes the
  // ones a rate-limit left unscored. A completed pass leaves current fully scored, so
  // the NEXT regenerate rotates it into the baseline.
  // O6b/D9: pre-commit cost preview for the Score action, from the runtime rates.
  const scoreSummary = scoreSelectionSummary(
    toBenchCases(),
    checkedCaseIds,
    (c) => caseRecords.get(c.id) ?? '',
  )

  async function scoreRun() {
    if (scoring || gen.running) return
    const set = getBenchSet(WORKBENCH_SET_ID)
    const run = set?.runs.current
    if (!set || !run) return

    const caseById = new Map(set.cases.map((c) => [c.id, c]))
    // O6b: score only checked cases; free/deterministic cases first (E29c) so
    // instant results render before any metered judge call books.
    const entries = deterministicFirst(
      Object.entries(run.outputs).filter(([caseId]) => checkedCaseIds.has(caseId)),
      ([caseId]) => {
        const c = caseById.get(caseId)
        return c ? meteredCallsForCase(c) : 0
      },
    )
    if (entries.length === 0) return
    setScoring(true)
    setScoreError(null)
    setScoreRateLimited(false)
    setScoreTotal(entries.length)
    let done = Object.keys(run.scores).length
    setScoredCount(done)

    try {
      for (const [caseId, output] of entries) {
        // Resume: a case already scored in this (surviving) run is not re-scored.
        if (run.scores[caseId]) continue
        const benchCase = caseById.get(caseId)
        if (!benchCase) continue

        const { row, rateLimited } = await scoreRunCase(benchCase, output, thresholds)
        if (rateLimited) {
          // Throttled — stop with progress preserved; the surviving outputs resume later.
          setScoreRateLimited(true)
          break
        }
        if (!row) continue

        try {
          persistScore(WORKBENCH_SET_ID, caseId, row)
        } catch (err) {
          setScoreError(err instanceof Error ? err.message : 'Could not save score')
          break
        }
        done++
        setRunScores((prev) => ({ ...prev, [caseId]: row }))
        setScoredCount(done)
      }
    } finally {
      setScoring(false)
    }
  }

  function resumeRegenerate() {
    if (gen.running) return
    // Resume keeps the in-flight run (and its persisted outputs) — do NOT startRun,
    // which would wipe current.outputs. Already-done cases are skipped by the hook.
    gen.resume(toGenerationCases(), generationPrompt, { onCaseDone: persistGeneratedOutput })
  }

  // Outputs available to score = the persisted run's outputs, mirrored into
  // restoredOutputs as each lands (and rehydrated on mount). Drives the Score CTA.
  const generatedCount = Object.keys(restoredOutputs).length

  const activeMeta = EVALUATOR_META[evaluator]
  const fieldScorers = FIELD_SCORERS[evaluator]
  const agreementLabel =
    agreement === null ? 'N/A' : `${agreeCount}/${n} agree`

  // The three pipeline atoms — Prompt → Cases → Evaluator (R16 landing).
  const pipelineAtoms = [
    {
      icon: 'doc' as const,
      n: 1,
      title: 'Prompt',
      desc: promptEdited ? 'edited · regenerate to re-run' : 'meds → grounded answer',
      tag: 'from your lesson',
    },
    {
      icon: 'target' as const,
      n: 2,
      title: 'Cases',
      desc: `${cases.length} pre-loaded patients`,
      tag: 'golden set',
    },
    {
      icon: 'flask' as const,
      n: 3,
      title: 'Evaluator',
      desc: EVALUATOR_LABEL[evaluator],
      tag: activeMeta.metered ? 'metered judge' : 'free diff',
      accent: true,
    },
  ]

  return (
    <div className={styles.bench} data-testid="workbench">
      {view === 'pipeline' ? (
        /* ── Pipeline landing — the eval as three atoms + a results badge ──── */
        <section className={styles.pipelineLanding} data-testid="workbench-pipeline">
          <span className={styles.eyebrow}>the open workbench</span>
          <h2 className={styles.pipelineHeading}>Your eval, as three knobs you control.</h2>
          <p className={styles.pipelineLede}>
            Everything you built in the lesson is loaded and already running. Nothing&apos;s
            blank — change any atom and re-grade. This is the whole machine, open.
          </p>

          <div className={styles.pipelineFlow}>
            {pipelineAtoms.map((a, i) => (
              <div className={styles.pipelineNodeWrap} key={a.n}>
                <button
                  type="button"
                  data-testid={`pipeline-atom-${a.n}`}
                  className={`${styles.pipelineNode} ${a.accent ? styles.pipelineNodeAccent : ''}`}
                  onClick={() => setView('panels')}
                >
                  <span className={styles.pipelineNodeHead}>
                    <span className={styles.atomIcon} aria-hidden>
                      <Icon name={a.icon} size={13} />
                    </span>
                    <span className={styles.atomEyebrow}>atom {a.n}</span>
                  </span>
                  <span className={styles.pipelineNodeTitle}>{a.title}</span>
                  <span className={styles.pipelineNodeDesc}>{a.desc}</span>
                  <span className={styles.pipelineNodeTag}>{a.tag}</span>
                </button>
                {i < pipelineAtoms.length - 1 && (
                  <span className={styles.pipelineArrow} aria-hidden>
                    <Icon name="arrow" size={16} />
                  </span>
                )}
              </div>
            ))}
            <span className={styles.pipelineArrow} aria-hidden>
              <Icon name="arrow" size={16} />
            </span>
            <div className={styles.resultsBadge} data-testid="pipeline-results-badge">
              <span className={styles.resultsBadgeValue}>
                {agreement === null ? 'N/A' : `${Math.round(agreement * 100)}%`}
              </span>
              <span className={styles.resultsBadgeLabel}>{agreementLabel}</span>
            </div>
          </div>

          <div className={styles.pipelineActions}>
            <button
              type="button"
              data-testid="open-the-bench-btn"
              className={styles.openBenchBtn}
              onClick={() => setView('panels')}
            >
              Open the bench <Icon name="arrow" size={15} />
            </button>
            <span className={styles.pipelineActionsHint}>
              or click any atom above to jump straight to it
            </span>
          </div>
        </section>
      ) : (
        /* ── Panels — the expanded three-panel daily driver (R16). The
             pipeline and the panels are mutually exclusive views of the same live
             bench: "open the bench" swaps one for the other, mirroring the design
             reference (bench.jsx). The results are already computed (open without
             empty), so expanding is instant. ─────────────────────────────────── */
        <>
          {/* Panels toolbar — back to the pipeline + bench heading */}
          <div className={styles.panelsToolbar}>
            <button
              type="button"
              data-testid="pipeline-view-btn"
              className={styles.pipelineViewBtn}
              onClick={() => setView('pipeline')}
            >
              <Icon name="layers" size={13} /> Pipeline view
            </button>
            <h2 className={styles.benchHeading}>The bench</h2>
            <span className={styles.benchHeadingHint}>change a knob → re-grade. no rails.</span>
          </div>

          {/* ── The three atom panels ──────────────────────────────────────── */}
          <div className={styles.atomGrid}>
        {/* atom 1 — prompt (the one live knob) */}
        <section className={styles.atomPanel} data-testid="prompt-panel">
          <header className={styles.atomHeader}>
            <span className={styles.atomIcon} aria-hidden>
              <Icon name="doc" size={12} />
            </span>
            <span className={styles.atomEyebrow}>atom 1 · prompt</span>
            <span className={styles.atomHeaderBadge}>live</span>
          </header>
          <div className={styles.atomBody}>
            <p className={styles.panelHint}>
              The one live knob. Editing it re-runs generation over every case through the model —
              not a no-op.
            </p>
            <GenerationPromptEditor
              value={generationPrompt}
              onChange={setGenerationPrompt}
              disabled={gen.running}
            />

            {promptStale && (
              <div className={styles.staleNote} data-testid="prompt-stale-note">
                The prompt changed. The results below still reflect the committed outputs —
                regenerate to run the new prompt live.
              </div>
            )}

            <div className={styles.actions}>
              <button
                type="button"
                data-testid="regenerate-btn"
                className={styles.primaryBtn}
                onClick={regenerate}
                disabled={gen.running}
              >
                {gen.running ? 'Regenerating…' : `Generate selected (${checkedCaseIds.size})`}
              </button>
              {gen.running && (
                <button
                  type="button"
                  data-testid="abort-regenerate-btn"
                  className={styles.ghostBtn}
                  onClick={gen.abort}
                >
                  Abort
                </button>
              )}
              {!gen.running && gen.rateLimited && (
                <button
                  type="button"
                  data-testid="resume-regenerate-btn"
                  className={styles.ghostBtn}
                  onClick={resumeRegenerate}
                >
                  Resume ({gen.completed}/{gen.total})
                </button>
              )}
              {/* Score the regenerated run (O7b) — grades runs.current.outputs, not a
                  frozen capture. Available whenever there are outputs to score
                  (including a run rehydrated after a reload). */}
              <button
                type="button"
                data-testid="score-run-btn"
                className={styles.primaryBtn}
                onClick={scoreRun}
                disabled={gen.running || scoring || generatedCount === 0}
              >
                {scoring
                  ? 'Scoring…'
                  : scoreRateLimited
                    ? `Resume scoring (${scoredCount}/${scoreTotal})`
                    : `Score selected (${scoreSummary.k} · ~${scoreSummary.meteredCalls} metered calls)`}
              </button>
              {scoreSummary.meteredCalls > 0 && (
                <span className={styles.costPreview} data-testid="cost-preview">
                  est. ~${scoreSummary.estUsd.toFixed(4)} before booking — free scorers run first
                </span>
              )}
            </div>

            {(scoring || scoredCount > 0) && scoreTotal > 0 && (
              <div className={styles.progress} data-testid="score-progress">
                Scored {scoredCount} / {scoreTotal}
                {scoring ? ' (in progress…)' : ''}
              </div>
            )}
            {scoreRateLimited && !scoring && (
              <div className={styles.staleNote} data-testid="score-rate-limit-banner">
                Rate-limited — {scoredCount} of {scoreTotal} scored. Resume scoring when the
                window resets.
              </div>
            )}
            {scoreError && (
              <div className={styles.staleNote} data-testid="score-error">
                Couldn&apos;t save scores: {scoreError} Completed scores are kept — export to free
                space.
              </div>
            )}

            {(gen.running || gen.completed > 0) && gen.total > 0 && (
              <div className={styles.progress} data-testid="regenerate-progress">
                Regenerated {gen.completed} / {gen.total}
                {gen.running && gen.activeCaseId ? ' (in progress…)' : ''}
              </div>
            )}
            {gen.rateLimited && !gen.running && (
              <div className={styles.staleNote} data-testid="regenerate-rate-limit-banner">
                Rate-limited — {gen.completed} of {gen.total} regenerated. Resume when the window
                resets.
              </div>
            )}
            {persistError && (
              <div className={styles.staleNote} data-testid="regenerate-persist-error">
                Couldn&apos;t save run to this browser: {persistError} Completed outputs are kept in
                this session — export to free space.
              </div>
            )}

            {/* ── O8 iteration delta (E27 / G3) ─────────────────────────────
                Previous-vs-current verdict flips + aggregate move, the payoff of
                the round-trip. The NUMBER renders only when rubric/threshold/scorer
                match across the two runs (E27); a moved one of those, or a
                mixed-prompt current run (S23), shows its OWN banner IN PLACE of the
                number — never conflated. A changed generation prompt annotates but
                never suppresses (that edit IS the measured change, G3). Every number
                carries n, and the ≥100-case-floor tension is named, never hidden. */}
            {delta.status === 'incomparable' && (
              <div className={styles.staleNote} data-testid="delta-incomparable-banner">
                {delta.banner}
              </div>
            )}
            {delta.status === 'mixed-prompt' && (
              <div className={styles.staleNote} data-testid="delta-mixed-prompt-banner">
                {delta.banner}
              </div>
            )}
            {delta.status === 'ok' && (
              <div className={styles.deltaPanel} data-testid="delta-panel">
                <strong className={styles.deltaHeadline} data-testid="delta-copy">
                  {delta.copy}
                </strong>
                {/* Aggregate move — raw pass counts over the SAME n, never a
                    "75% → 100%" celebration (the exact mistake G3 forbids). */}
                <span className={styles.deltaNote} data-testid="delta-aggregate">
                  pass: {delta.previousPass}/{delta.n} → {delta.currentPass}/{delta.n}
                </span>
                {deltaAnnotation(delta) && (
                  <span className={styles.deltaNote} data-testid="delta-across-prompts-note">
                    {deltaAnnotation(delta)}
                  </span>
                )}
                {floorCaveat(delta) && (
                  <span className={styles.deltaCaveat} data-testid="delta-floor-caveat">
                    {floorCaveat(delta)}
                  </span>
                )}
              </div>
            )}
          </div>
        </section>

        {/* atom 2 — cases + record inspector */}
        <section className={styles.atomPanel} data-testid="cases-panel">
          <header className={styles.atomHeader}>
            <span className={styles.atomIcon} aria-hidden>
              <Icon name="target" size={12} />
            </span>
            <span className={styles.atomEyebrow}>atom 2 · cases</span>
            <span className={styles.atomHeaderCount}>
              {cases.length} selected
              {authoredCount > 0 ? ` · ${authoredCount} authored` : ''}
            </span>
          </header>
          <div className={styles.atomBody}>
            <p className={styles.panelHint}>
              Pre-loaded from the lesson&apos;s last state. Select one to inspect its record.
            </p>

            {/* Add-case flow (S24) — the composer in the cases atom. */}
            <button
              type="button"
              data-testid="add-case-toggle"
              aria-expanded={composerOpen}
              className={styles.ghostBtn}
              onClick={() => setComposerOpen((v) => !v)}
            >
              {composerOpen ? 'Close composer' : '+ Add case'}
            </button>
            {composerOpen && (
              <div className={styles.composerMount} data-testid="composer-mount">
                <CaseComposer onAdded={(set) => setAuthoredCount(set.cases.length)} />
              </div>
            )}

            {/* RAG mode (O10 / G4) — retrieve vs stuff, made part of the practice. */}
            <button
              type="button"
              data-testid="rag-mode-toggle"
              aria-expanded={ragOpen}
              className={styles.ghostBtn}
              onClick={() => setRagOpen((v) => !v)}
            >
              {ragOpen ? 'Close RAG mode' : 'RAG mode (retrieve vs stuff)'}
            </button>
            {ragOpen && (
              <div className={styles.composerMount} data-testid="rag-mount">
                <RagInspector />
              </div>
            )}

            <ul className={styles.caseList}>
              {cases.map((c) => (
                <li key={c.caseId} className={styles.caseRow}>
                  <input
                    type="checkbox"
                    data-testid={`case-check-${c.caseId}`}
                    aria-label={`Include ${c.caseId} in generate/score`}
                    className={styles.caseCheck}
                    checked={checkedCaseIds.has(c.caseId)}
                    onChange={() => toggleChecked(c.caseId)}
                  />
                  <button
                    type="button"
                    data-testid={`case-select-${c.caseId}`}
                    aria-pressed={selectedCaseId === c.caseId}
                    className={`${styles.caseItem} ${selectedCaseId === c.caseId ? styles.caseItemActive : ''}`}
                    onClick={() => setSelectedCaseId(c.caseId)}
                  >
                    <span className={styles.casePrompt}>
                      {c.taskPrompt.slice(0, 70)}
                      {c.taskPrompt.length > 70 ? '…' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            {selectedCase && (
              <div className={styles.inspector} data-testid="record-inspector">
                <strong className={styles.inspectorTitle}>
                  Record inspector —{' '}
                  <Term
                    term="grounding"
                    definition="The retrieved context the model and the faithfulness judge see. There is no separate answer key for faithfulness — this is the only source of truth."
                  />
                </strong>
                {selectedCase.grounding.map((g, i) => (
                  <div className={styles.groundingChunk} key={i} data-testid={`grounding-chunk-${i}`}>
                    <strong>[{g.section}]</strong> {g.text}
                  </div>
                ))}
                {(() => {
                  const r = gen.results[selectedCase.caseId]
                  // Live stream takes precedence; otherwise fall back to the output
                  // persisted in runs.current.outputs (rehydrated on mount) so a
                  // reload shows the generated output the user already paid for.
                  if (!r || r.status === 'pending') {
                    const restored = restoredOutputs[selectedCase.caseId]
                    if (!restored) return null
                    return (
                      <div
                        className={styles.regenOutput}
                        data-testid={`regenerated-output-${selectedCase.caseId}`}
                        data-restored="true"
                      >
                        <strong>Regenerated output (restored)</strong>
                        <div>{restored.text}</div>
                      </div>
                    )
                  }
                  return (
                    <div
                      className={styles.regenOutput}
                      data-testid={`regenerated-output-${selectedCase.caseId}`}
                    >
                      <strong>
                        Regenerated output
                        {r.status === 'running' ? ' (streaming…)' : ''}
                        {r.status === 'error' ? ' — failed' : ''}
                      </strong>
                      <div>
                        {r.status === 'error'
                          ? (r.error ?? 'Generation failed')
                          : r.output || (r.status === 'running' ? '…' : '')}
                      </div>
                    </div>
                  )
                })()}
                {(() => {
                  // Fresh score for the selected case (O7b) — read from runs.current.scores
                  // via runScores. Tied to the regenerated output above (not a frozen
                  // capture): it clears on regenerate and is recomputed on the next score
                  // pass, so the surface never shows a stale (display-only) score.
                  const row = runScores[selectedCase.caseId]
                  if (!row) return null
                  const scoreLabel = row.score === null ? 'N/A' : row.score.toFixed(2)
                  return (
                    <div
                      className={styles.regenOutput}
                      data-testid={`run-score-${selectedCase.caseId}`}
                      data-score-state={row.state}
                    >
                      <strong>Score (this run)</strong>
                      <div>
                        {scoreLabel} · {row.state}
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        </section>

        {/* atom 3 — evaluator palette */}
        <section
          className={`${styles.atomPanel} ${styles.atomPanelEval}`}
          data-testid="evaluator-palette"
        >
          <header
            className={`${styles.atomHeader} ${evaluator === 'faithfulness' ? styles.atomHeaderSpot : styles.atomHeaderAccent}`}
          >
            <span className={styles.atomIcon} aria-hidden>
              <Icon name="flask" size={12} />
            </span>
            <span className={styles.atomEyebrow}>atom 3 · evaluator</span>
          </header>
          <div className={styles.atomBody}>
            <p className={styles.panelHint}>
              Pick how each case is graded.{' '}
              <Term
                term="Faithfulness"
                definition="Checks whether every atomic claim in the output is grounded in the provided context. It needs no answer key — that is why its surface has no expected column."
              />{' '}
              reshapes the surface: no expected column, just grounding + claims.
            </p>
            <div className={styles.palette}>
              {EVALUATORS.map((e) => {
                const meta = EVALUATOR_META[e]
                const active = evaluator === e
                return (
                  <button
                    key={e}
                    type="button"
                    data-testid={`evaluator-option-${e}`}
                    aria-pressed={active}
                    className={`${styles.evalOption} ${active ? styles.evalOptionActive : ''}`}
                    onClick={() => setEvaluator(e)}
                  >
                    <span className={styles.evalOptionHead}>
                      <strong className={styles.evalOptionName}>{EVALUATOR_LABEL[e]}</strong>
                      {active && (
                        <span className={styles.evalOptionCheck} aria-hidden>
                          <Icon name="check" size={13} />
                        </span>
                      )}
                    </span>
                    <span className={styles.evalOptionWhen}>{meta.when}</span>
                    <span className={styles.evalOptionCost}>{meta.cost}</span>
                  </button>
                )
              })}
            </div>

            {/* Per-field scorer chips — each schema field tagged with its scorer. */}
            <div className={styles.perField} data-testid="per-field-scorers">
              <span className={styles.atomEyebrow}>per field</span>
              <div className={styles.fieldChips}>
                {fieldScorers.map((f) => (
                  <span
                    key={f.field}
                    className={`${styles.fieldChip} ${f.scorer === 'judge' ? styles.fieldChipJudge : styles.fieldChipDiff}`}
                    data-testid={`field-scorer-${f.field}`}
                  >
                    <span className={styles.fieldChipName}>{f.field}</span>
                    <span className={styles.fieldChipDot}>·</span>
                    <span className={styles.fieldChipScorer}>{f.scorer}</span>
                  </span>
                ))}
              </div>
            </div>

            {/* Rubric knob — only meaningful for faithfulness. */}
            {evaluator === 'faithfulness' && (
              <div className={styles.rubricKnob} data-testid="rubric-knob">
                <p className={styles.panelHint}>
                  Rubric — how strictly &quot;grounded&quot; is read. Switch it and watch the
                  allergies case flip from agree to disagree.
                </p>
                <div className={styles.segmented} role="group" aria-label="Rubric strictness">
                  {(['strict', 'lenient'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      data-testid={`rubric-${r}`}
                      aria-pressed={rubric === r}
                      className={`${styles.segment} ${rubric === r ? styles.segmentActive : ''}`}
                      onClick={() => setRubric(r)}
                    >
                      {RUBRIC_LABEL[r]}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* ── Results surface — reshapes with the evaluator ─────────────────── */}
      <section className={styles.resultsSection} data-testid="results-panel" data-evaluator={evaluator}>
        <header className={styles.resultsHeader}>
          <span className={styles.atomEyebrow}>results</span>
          <h3 className={styles.resultsTitle}>
            {EVALUATOR_LABEL[evaluator]}
            {evaluatorHasAnswerKey(evaluator) ? '' : ' · grounding + agreement view'}
          </h3>
          {/* Cost strip — free diff vs metered judge. */}
          <span
            className={`${styles.costStrip} ${activeMeta.metered ? styles.costStripMetered : styles.costStripFree}`}
            data-testid="cost-strip"
            data-metered={activeMeta.metered ? 'true' : 'false'}
          >
            <Icon name="bolt" size={11} />
            {activeMeta.cost}
          </span>
          <span className={styles.resultsHint}>
            {evaluatorHasAnswerKey(evaluator)
              ? 'red row = the evaluator disagrees with your label — open the record to settle it'
              : "flagged = a claim the record doesn't support"}
          </span>
        </header>
        {evaluator === 'faithfulness' ? (
          <DisagreementTable
            results={results}
            initialThreshold={thresholds.faithfulness}
            onIntentLabelChange={handleIntentLabelChange}
          />
        ) : (
          <EvaluatorResultsTable
            evaluator={evaluator}
            cases={cases}
            results={results}
            diffDetails={diffDetails}
            onIntentLabelChange={handleIntentLabelChange}
          />
        )}
          </section>

          {/* ── Clinician seat (G5 / E26) — the user labels scored outputs and the
               agreement metric reports how often the judge agrees. Distinct from the
               designed intent labels above: these are the clinician's own verdicts,
               persisted in BenchSet.labels independently of runs. ──────────────── */}
          <section className={styles.resultsSection}>
            <ClinicianAgreement
              results={results}
              labels={userLabels}
              threshold={evaluatorThreshold}
              onLabel={handleUserLabel}
              onClearLabel={handleClearUserLabel}
            />

            <JudgeRubricEditor
              value={judgeRubric}
              onChange={setJudgeRubric}
              canRescore
              onRescore={rescoreProbe}
              rescoring={rescoring}
              rescoreResult={rescoreResult}
              rescoreError={rescoreError}
            />

            <BenchSetIO
              set={getBenchSet(WORKBENCH_SET_ID) ?? null}
              onImport={(s) => saveBenchSet(s)}
            />
          </section>
        </>
      )}
    </div>
  )
}
