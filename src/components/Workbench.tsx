'use client'

import { useMemo, useState } from 'react'
import { DisagreementTable } from './DisagreementTable'
import { EvaluatorResultsTable } from './EvaluatorResultsTable'
import { GenerationPromptEditor, DEFAULT_GENERATION_PROMPT } from './GenerationPromptEditor'
import { Term } from './Term'
import { useGenerationRun, type GenerationCase } from '@/hooks/useGenerationRun'
import {
  computeUserAgreement,
  DEFAULT_PASS_THRESHOLD,
} from '@/lib/eval/user-agreement'
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
import styles from './Workbench.module.css'

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
  const [generationPrompt, setGenerationPrompt] = useState(DEFAULT_GENERATION_PROMPT)

  // Land on the pipeline; "open the bench" expands to the panels (R16).
  const [view, setView] = useState<BenchView>('pipeline')

  // The live generation fan-out (R1). Editing the prompt and regenerating re-runs
  // generation over every case — the keystone the prototype faked.
  const gen = useGenerationRun()

  // Results recompute synchronously whenever the evaluator, rubric, or labels
  // change — that is "changing any knob re-runs" for the deterministic knobs.
  const results = useMemo(
    () => buildBenchResults(evaluator, cases, rubric, thresholds, labelOverrides),
    [evaluator, cases, rubric, thresholds, labelOverrides],
  )

  // Aggregate agreement drives the pipeline's results badge — "the whole machine,
  // open" needs a live number on the landing, not a blank chip.
  const { agreement, n, agreeCount } = useMemo(
    () => computeUserAgreement(results, DEFAULT_PASS_THRESHOLD),
    [results],
  )

  const promptEdited = generationPrompt !== DEFAULT_GENERATION_PROMPT
  // Prompt edited but not yet regenerated → the deterministic results no longer
  // reflect the live prompt. Surface that, and offer the live re-run.
  const promptStale = promptEdited && gen.completed === 0 && !gen.running

  const selectedCase = cases.find((c) => c.caseId === selectedCaseId) ?? cases[0]

  function handleIntentLabelChange(caseId: string, label: 'pass' | 'fail') {
    setLabelOverrides((prev) => ({ ...prev, [caseId]: label }))
  }

  function toGenerationCases(): GenerationCase[] {
    // Stuff mode: the committed grounding IS the record, so the live run grounds on
    // exactly what the offline surface showed. patientId is the synthetic case id
    // (stuff mode never touches the patient table for retrieval).
    return cases.map((c) => ({
      id: c.caseId,
      patientId: c.caseId,
      query: c.taskPrompt,
      mode: 'stuff' as const,
      record: assembleGrounding(c.grounding),
    }))
  }

  function regenerate() {
    if (gen.running) return
    gen.run(toGenerationCases(), generationPrompt)
  }

  function resumeRegenerate() {
    if (gen.running) return
    gen.resume(toGenerationCases(), generationPrompt)
  }

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
        /* ── Panels toolbar — back to the pipeline + bench heading ─────────── */
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
      )}

      {/* ── The three atom panels (always mounted — "already running") ─────── */}
      <div className={styles.atomGrid} data-bench-view={view}>
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
                {gen.running ? 'Regenerating…' : `Regenerate all (${cases.length})`}
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
            </div>

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
          </div>
        </section>

        {/* atom 2 — cases + record inspector */}
        <section className={styles.atomPanel} data-testid="cases-panel">
          <header className={styles.atomHeader}>
            <span className={styles.atomIcon} aria-hidden>
              <Icon name="target" size={12} />
            </span>
            <span className={styles.atomEyebrow}>atom 2 · cases</span>
            <span className={styles.atomHeaderCount}>{cases.length} selected</span>
          </header>
          <div className={styles.atomBody}>
            <p className={styles.panelHint}>
              Pre-loaded from the lesson&apos;s last state. Select one to inspect its record.
            </p>
            <ul className={styles.caseList}>
              {cases.map((c) => (
                <li key={c.caseId}>
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
                  if (!r || r.status === 'pending') return null
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
    </div>
  )
}
