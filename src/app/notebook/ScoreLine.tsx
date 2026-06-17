'use client'

import { useCallback } from 'react'
import {
  projectEvalTrail,
  safeImportState,
  scoredEvalKeys,
  serializeState,
  type NotebookState,
} from '@/lib/notebook/state'
import styles from './notebook.module.css'

/**
 * Score line (SHA-163 N11) — a PROJECTION of the N4 bench-state cube, never a
 * parallel structure. Each row reads `scores[evalKey]` across the last 3 scored
 * runs in `state.runs` order and renders them prev → current. The later grid
 * (N15b) reads the very same cells at full width.
 *
 * The disputed-cell indicator is intentionally ABSENT here — it lands with the
 * grid in N15b (it reads judge-row `agree` data this projection deliberately does
 * not surface). Its absence is by design, not a gap.
 *
 * Export sits beside the line and serializes the WHOLE cube + meta (model ids,
 * app version) — NOT the trail subset on screen. It round-trips through the N4
 * import validator (`safeImportState`) before download, so a malformed export can
 * never leave the app.
 */

const NUM_RUNS_IN_TRAIL = 3

function labelFor(state: NotebookState, evalKey: string): string {
  if (evalKey === 'golden') return 'golden'
  return state.evals.find((e) => e.key === evalKey)?.label ?? evalKey
}

/** Trigger a client-side download of the serialized cube. */
function downloadExport(json: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'notebook-bench-state.json'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function ScoreLine({ state }: { state: NotebookState }) {
  const onExport = useCallback(() => {
    // Export is the FULL cube + meta — serialize the whole NotebookState, never
    // the trail subset. Re-validate the round-trip through the N4 import gate so a
    // malformed payload is caught here rather than downloaded.
    const json = serializeState(state)
    const check = safeImportState(json)
    if (!check.ok) {
      // Should be unreachable (state is always schema-valid) — fail loud, not silent.
      console.error('Notebook export failed validation:', check.error)
      return
    }
    downloadExport(json)
  }, [state])

  const evalKeys = scoredEvalKeys(state)

  // Before any eval is scored there is nothing to project — keep the section
  // present (the scaffolding) but quiet.
  if (evalKeys.length === 0) {
    return (
      <section className={styles.cell} data-testid="section-score" aria-label="Score">
        <span className={styles.cellLabel}>Score</span>
        <p className={styles.cellPlaceholder}>
          Score an eval above and the run-over-run trail shows up here.
        </p>
      </section>
    )
  }

  return (
    <section className={styles.cell} data-testid="section-score" aria-label="Score">
      <div className={styles.scoreHead}>
        <span className={styles.cellLabel}>Score</span>
        <button
          type="button"
          className={styles.btnGhostLink}
          data-testid="score-export"
          onClick={onExport}
        >
          ↓ Export
        </button>
      </div>

      <div className={styles.scoreLines}>
        {evalKeys.map((evalKey) => {
          const trail = projectEvalTrail(state, evalKey, NUM_RUNS_IN_TRAIL)
          if (trail.length === 0) return null
          return (
            <div
              key={evalKey}
              className={styles.scoreline}
              data-testid="score-trail"
              data-eval-key={evalKey}
            >
              <span className={styles.slLabel}>{labelFor(state, evalKey)}</span>
              <div className={styles.slTrail}>
                {trail.map((step, i) => {
                  const isCurrent = i === trail.length - 1
                  return (
                    <span key={step.runId} className={styles.slStep}>
                      {i > 0 && (
                        <span className={styles.slSep} aria-hidden="true">
                          →
                        </span>
                      )}
                      <span
                        className={`${styles.slNum} ${isCurrent ? styles.slNumCur : ''}`}
                        data-testid="trail-frac"
                        data-run-id={step.runId}
                        data-current={isCurrent ? 'true' : 'false'}
                        title={`run ${step.version}`}
                      >
                        {step.frac}
                      </span>
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
