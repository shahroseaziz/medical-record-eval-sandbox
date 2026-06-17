'use client'

import { useState } from 'react'
import { modelDisplayName } from '@/lib/models'
import type { ContextManifest } from '@/lib/run/context-manifest'
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
 *
 * "What the model saw" (SHA-160 N8b) — each done card carries a toggleable receipt
 * rendering the `type:'context'` manifest the run emitted (captured in
 * `result.context`). It is HONEST about the grounding mode: in FULL mode it reads
 * "full chart · fit in context" and lists the sections sent; in RETRIEVED mode it
 * reads "retrieved sections · chart too large", lists the retrieved sections, and
 * names any `droppedSections` the budget cut. It renders ONLY what the manifest
 * carries — no raw record text is re-shipped, and nothing is fabricated.
 */

interface OutputCardProps {
  result: OutputCardResult
  patient: NotebookPatient | undefined
  onViewChart: (patientId: string) => void
  /** This run's output predates the current prompt — quiet the card, disable scoring. */
  stale: boolean
  /** Re-run just this patient (per-patient Resume after a rate-limit). */
  onResume: (patientId: string) => void
}

/**
 * The "what the model saw" receipt — renders the context manifest for a done card.
 * Pure presentation of `result.context`: mode label, the sections the model saw
 * (name + char size), and any sections dropped for budget. Both modes covered;
 * the default full/stuff path included.
 */
function ContextReceipt({ context, model }: { context: ContextManifest; model: string | null }) {
  const retrieved = context.contextMode === 'retrieved'
  const modeCopy = retrieved
    ? 'retrieved sections · chart too large'
    : 'full chart · fit in context'
  const dropped = context.droppedSections ?? []

  return (
    <div className={styles.saw} data-testid="context-receipt" data-context-mode={context.contextMode}>
      <div className={styles.sawHead}>
        <span className={styles.sawTitle}>
          What {model ? modelDisplayName(model) : 'the model'} saw · read-only
        </span>
        <span
          className={`${styles.sawCtx} ${retrieved ? styles.ctxWarn : styles.ctxOk}`}
          data-testid="context-mode-label"
        >
          {modeCopy}
        </span>
      </div>

      {context.sections.length > 0 ? (
        <ul className={styles.sawSections}>
          {context.sections.map((s, i) => (
            <li
              key={`${s.section}-${i}`}
              className={styles.sawSection}
              data-testid="context-section"
            >
              <span className={styles.sawSectionName}>{s.section}</span>
              <span className={styles.sawSectionChars}>{s.chars.toLocaleString()} chars</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.sawEmpty}>No context was sent to the model.</p>
      )}

      {dropped.length > 0 && (
        <div className={styles.sawDropped} data-testid="context-dropped">
          <span className={styles.sawDroppedLabel}>dropped for budget</span>
          <span className={styles.sawDroppedList}>{dropped.join(' · ')}</span>
        </div>
      )}
    </div>
  )
}

function OutputCard({ result, patient, onViewChart, stale, onResume }: OutputCardProps) {
  const [sawOpen, setSawOpen] = useState(false)
  const name = patient?.name ?? result.patientId
  const done = result.status === 'done'
  const streaming = result.status === 'streaming'
  const errored = result.status === 'error'
  const rateLimited = result.status === 'rate-limited'
  const modelLabel = result.model ? modelDisplayName(result.model) : null

  // ── Rate-limited card (REAL Upstash limiter 429) ──────────────────────────
  // Driven by the limiter's response — never a simulated toggle. Plain language,
  // honest that nothing was charged, with a per-patient Resume (re-run just this
  // patient: the shared limit may have cleared, or a key was added).
  if (rateLimited) {
    return (
      <div
        className={`${styles.ocard} ${styles.ocardFail}`}
        data-testid="output-card"
        data-patient-id={result.patientId}
        data-status="rate-limited"
      >
        <div className={styles.ocardHead}>
          <span className={styles.ocName}>{name}</span>
          <span className={styles.ocRight}>
            <span className={styles.ocFlagWarn} data-testid="rate-limited-flag">
              rate-limited
            </span>
          </span>
        </div>
        <div className={styles.cardState} data-testid="rate-limited-state">
          <p className={styles.csText}>
            The shared free-tier limit was reached before this patient ran — nothing was charged.
          </p>
          <button
            type="button"
            className={styles.csBtn}
            data-testid="resume-patient"
            onClick={() => onResume(result.patientId)}
          >
            Resume this patient
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`${styles.ocard} ${streaming ? styles.ocardStreaming : ''} ${errored ? styles.ocardFail : ''} ${stale ? styles.ocardStale : ''}`}
      data-testid="output-card"
      data-patient-id={result.patientId}
      data-status={result.status}
      data-stale={stale ? 'true' : 'false'}
    >
      <div className={styles.ocardHead}>
        <span className={styles.ocName}>{name}</span>
        <span className={styles.ocRight}>
          {errored ? (
            <span className={styles.ocFlagWarn}>failed</span>
          ) : stale && done ? (
            // Edited since this run: the output no longer reflects the prompt above.
            <span className={styles.ocStaleFlag} data-testid="stale-flag">
              stale — re-run
            </span>
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
        <>
          <div className={styles.ocFoot}>
            <button
              type="button"
              className={styles.linkBtn}
              data-testid="view-chart"
              onClick={() => onViewChart(result.patientId)}
            >
              view chart
            </button>
            {result.context && (
              <button
                type="button"
                className={`${styles.linkBtn} ${styles.linkBtnQuiet}`}
                data-testid="what-model-saw"
                aria-expanded={sawOpen}
                onClick={() => setSawOpen((o) => !o)}
              >
                what the model saw
              </button>
            )}
            {modelLabel && <span className={styles.ocModelTag}>{modelLabel}</span>}
          </div>
          {sawOpen && result.context && (
            <ContextReceipt context={result.context} model={result.model} />
          )}
        </>
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
  /**
   * The current prompt differs from the one that produced this run — quiet the
   * cards and flag them "stale — re-run". Pure client state; defaults to false.
   */
  stale?: boolean
  /** Re-run just one patient (per-patient Resume after a rate-limit). */
  onResume?: (patientId: string) => void
  /**
   * The REAL daily kill-switch tripped (spend cap). Replaces the cards with a
   * preserved-state panel offering the BYO "Add your key" path; the prompt +
   * selected patients live in the shell and are untouched. Defaults to false.
   */
  spendCapped?: boolean
  /** Open the BYO key entry (the "Add your key" path). */
  onAddKey?: () => void
}

export function OutputCell({
  order,
  results,
  patientsById,
  onViewChart,
  stale = false,
  onResume,
  spendCapped = false,
  onAddKey,
}: OutputCellProps) {
  const resume = onResume ?? (() => {})

  // ── Spend-cap state (REAL daily kill-switch 429) ──────────────────────────
  // Checked FIRST: the cap can trip on the very first patient (no cards yet). The
  // prompt + selected patients are PRESERVED in the shell — this panel only offers
  // the BYO path. Driven by the kill-switch signal, never a simulated toggle.
  if (spendCapped) {
    return (
      <section className={styles.cell} data-testid="section-output" aria-label="Model output">
        <span className={styles.cellLabel}>Model output</span>
        <div className={styles.capState} data-testid="spend-cap-state">
          <div className={styles.capBody}>
            <div className={styles.capTitle}>Free-tier daily limit reached</div>
            <p className={styles.capSub}>
              Today&apos;s shared free-tier budget is used up. Your prompt and the patients you
              picked are kept — add your own key to keep running.
            </p>
            <button
              type="button"
              className={styles.btnPrimarySm}
              data-testid="spend-cap-add-key"
              onClick={onAddKey}
            >
              Add your key
            </button>
          </div>
        </div>
      </section>
    )
  }

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
        {stale && (
          <span className={styles.outStale} data-testid="output-stale-note">
            edited since this run
          </span>
        )}
      </div>
      <div className={styles.ocards}>
        {cards.map((r) => (
          <OutputCard
            key={r.patientId}
            result={r}
            patient={patientsById.get(r.patientId)}
            onViewChart={onViewChart}
            stale={stale}
            onResume={resume}
          />
        ))}
      </div>
    </section>
  )
}
