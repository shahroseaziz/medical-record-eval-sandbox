'use client'

import { useMemo, useState } from 'react'
import { DisagreementTable } from './DisagreementTable'
import { EvaluatorResultsTable } from './EvaluatorResultsTable'
import { GenerationPromptEditor, DEFAULT_GENERATION_PROMPT } from './GenerationPromptEditor'
import { Term } from './Term'
import { useGenerationRun, type GenerationCase } from '@/hooks/useGenerationRun'
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

const PIPELINE_STAGES = ['Prompt', 'Generate', 'Evaluate', 'Agreement'] as const

/**
 * The open workbench (R11). Prompt, cases, and evaluator are free knobs and the
 * surface is never empty — it lands pre-loaded from the lesson's last state.
 *
 * Knobs:
 *  - Evaluator (palette of 3): faithfulness reshapes the surface — no expected
 *    column, just grounding + claims + agreement. Reference-judge and structured-
 *    diff add an expected (answer-key) column.
 *  - Rubric (strict/lenient): re-derives faithfulness from committed per-claim
 *    verdicts. The red-cell aha lives here — the allergies case agrees under the
 *    strict rubric but disagrees (yellow) under the lenient one.
 *  - Intent label: flip a case pass/fail and watch agreement move.
 *  - Generation prompt: the one LIVE knob (R1). Editing it re-runs generation over
 *    every case through /api/run — not a no-op.
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

  // The live generation fan-out (R1). Editing the prompt and regenerating re-runs
  // generation over every case — the keystone the prototype faked.
  const gen = useGenerationRun()

  // Results recompute synchronously whenever the evaluator, rubric, or labels
  // change — that is "changing any knob re-runs" for the deterministic knobs.
  const results = useMemo(
    () => buildBenchResults(evaluator, cases, rubric, thresholds, labelOverrides),
    [evaluator, cases, rubric, thresholds, labelOverrides],
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

  return (
    <div className={styles.bench} data-testid="workbench">
      {/* Pipeline strip — the eval flow as stages above the panels. */}
      <div className={styles.pipeline} data-testid="workbench-pipeline">
        {PIPELINE_STAGES.map((stage, i) => (
          <span key={stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span
              className={`${styles.stage} ${stage === 'Evaluate' ? styles.stageActive : ''}`}
              data-testid={`pipeline-stage-${stage.toLowerCase()}`}
            >
              {stage}
            </span>
            {i < PIPELINE_STAGES.length - 1 && <span className={styles.arrow}>→</span>}
          </span>
        ))}
      </div>

      <div className={styles.grid}>
        {/* ── Left column: the knobs ─────────────────────────────────────── */}
        <div className={styles.column}>
          {/* Evaluator palette */}
          <section className={styles.panel} data-testid="evaluator-palette">
            <h3 className={styles.panelTitle}>Evaluator</h3>
            <p className={styles.panelHint}>
              Pick how each case is graded.{' '}
              <Term
                term="Faithfulness"
                definition="Checks whether every atomic claim in the output is grounded in the provided context. It needs no answer key — that is why its surface has no expected column."
              />{' '}
              reshapes the surface: no expected column, just grounding + claims.
            </p>
            <div className={styles.palette}>
              {EVALUATORS.map((e) => (
                <button
                  key={e}
                  type="button"
                  data-testid={`evaluator-option-${e}`}
                  aria-pressed={evaluator === e}
                  className={`${styles.evalOption} ${evaluator === e ? styles.evalOptionActive : ''}`}
                  onClick={() => setEvaluator(e)}
                >
                  {EVALUATOR_LABEL[e]}
                </button>
              ))}
            </div>

            {/* Rubric knob — only meaningful for faithfulness. */}
            {evaluator === 'faithfulness' && (
              <div data-testid="rubric-knob">
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
          </section>

          {/* Generation prompt — the live knob (R1) */}
          <section className={styles.panel} data-testid="prompt-panel">
            <h3 className={styles.panelTitle}>Generation prompt (live)</h3>
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
                onClick={regenerate}
                disabled={gen.running}
              >
                {gen.running ? 'Regenerating…' : `Regenerate all (${cases.length})`}
              </button>
              {gen.running && (
                <button type="button" data-testid="abort-regenerate-btn" onClick={gen.abort}>
                  Abort
                </button>
              )}
              {!gen.running && gen.rateLimited && (
                <button type="button" data-testid="resume-regenerate-btn" onClick={resumeRegenerate}>
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
          </section>

          {/* Cases + record inspector */}
          <section className={styles.panel} data-testid="cases-panel">
            <h3 className={styles.panelTitle}>Cases</h3>
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
                <strong>
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
          </section>
        </div>

        {/* ── Right column: the results surface ───────────────────────────── */}
        <div className={styles.column}>
          <section className={styles.panel} data-testid="results-panel" data-evaluator={evaluator}>
            <h3 className={styles.panelTitle}>
              Results — {EVALUATOR_LABEL[evaluator]}
              {evaluatorHasAnswerKey(evaluator) ? '' : ' · grounding + agreement view'}
            </h3>
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
      </div>
    </div>
  )
}
