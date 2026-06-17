'use client'

import { modelDisplayName } from '@/lib/models'
import type { OutputCardResult } from './useNotebookRun'
import type { NotebookPatient } from './types'
import styles from './notebook.module.css'

/**
 * Output cell (SHA-159 N8a) — one streaming card per patient the prompt ran
 * against. Tokens render as they arrive; while a card is still streaming it shows
 * a live "streaming" badge, and on completion it stamps the PRODUCING model id.
 *
 * The model stamp is read from the streamed response (`result.model`, captured
 * from the trace frame's `generationModel`) — never a literal in this component,
 * so it cannot drift from lib/models (rule 13 single id source). `modelDisplayName`
 * only formats the id that travelled back in the response.
 *
 * The "view chart" link is an INTENTIONAL, DEFINED stub: it fires `onViewChart`
 * (wired to a live target in the shell) so the control is real, not dead. The
 * chart drawer itself lands in N7b (parallel work) — this is acceptance-noted
 * collateral, not an incomplete feature.
 */

interface OutputCardProps {
  result: OutputCardResult
  patient: NotebookPatient | undefined
  onViewChart: (patientId: string) => void
}

function OutputCard({ result, patient, onViewChart }: OutputCardProps) {
  const name = patient?.name ?? result.patientId
  const done = result.status === 'done'
  const streaming = result.status === 'streaming'
  const errored = result.status === 'error'
  const modelLabel = result.model ? modelDisplayName(result.model) : null

  return (
    <div
      className={`${styles.ocard} ${streaming ? styles.ocardStreaming : ''} ${errored ? styles.ocardFail : ''}`}
      data-testid="output-card"
      data-patient-id={result.patientId}
      data-status={result.status}
    >
      <div className={styles.ocardHead}>
        <span className={styles.ocName}>{name}</span>
        <span className={styles.ocRight}>
          {errored ? (
            <span className={styles.ocFlagWarn}>failed</span>
          ) : done ? (
            modelLabel && (
              // The model stamp — sourced from the response, not a literal.
              <span className={styles.ocStamp} data-testid="model-stamp" data-model-id={result.model}>
                {modelLabel}
              </span>
            )
          ) : streaming ? (
            <span className={styles.ocStreaming} data-testid="streaming-flag">
              <span className={styles.blink} aria-hidden="true" />
              streaming
            </span>
          ) : (
            <span className={styles.ocPending}>queued</span>
          )}
        </span>
      </div>

      {errored ? (
        <div className={styles.ocError}>{result.error ?? 'The run did not complete.'}</div>
      ) : (
        <pre className={styles.ocJson}>
          <code>
            {result.output}
            {streaming && <span className={styles.caret} aria-hidden="true" />}
          </code>
        </pre>
      )}

      {done && (
        <div className={styles.ocFoot}>
          <button
            type="button"
            className={styles.linkBtn}
            data-testid="view-chart"
            onClick={() => onViewChart(result.patientId)}
          >
            view chart
          </button>
          {modelLabel && <span className={styles.ocModelTag}>{modelLabel}</span>}
        </div>
      )}
    </div>
  )
}

export interface OutputCellProps {
  /** Cards in selection order. */
  order: string[]
  results: Record<string, OutputCardResult>
  patientsById: Map<string, NotebookPatient>
  onViewChart: (patientId: string) => void
}

export function OutputCell({ order, results, patientsById, onViewChart }: OutputCellProps) {
  const cards = order.map((id) => results[id]).filter(Boolean)
  if (cards.length === 0) {
    return (
      <section className={styles.cell} data-testid="section-output" aria-label="Model output">
        <span className={styles.cellLabel}>Model output</span>
        <p className={styles.cellPlaceholder}>
          Run the prompt to see the model&apos;s answer for each selected patient.
        </p>
      </section>
    )
  }

  const noun = cards.length === 1 ? 'patient' : 'patients'
  return (
    <section className={styles.cell} data-testid="section-output" aria-label="Model output">
      <div className={styles.outHead}>
        <span className={styles.cellLabel}>Model output</span>
        <span className={styles.outSub}>
          {cards.length} {noun} · JSON
        </span>
      </div>
      <div className={styles.ocards}>
        {cards.map((r) => (
          <OutputCard
            key={r.patientId}
            result={r}
            patient={patientsById.get(r.patientId)}
            onViewChart={onViewChart}
          />
        ))}
      </div>
    </section>
  )
}
