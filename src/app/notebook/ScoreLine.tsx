'use client'

import { useCallback, useState } from 'react'
import {
  projectEvalTrail,
  safeImportState,
  scoredEvalKeys,
  scoredRunsInOrder,
  serializeState,
  type NotebookState,
} from '@/lib/notebook/state'
import styles from './notebook.module.css'

/**
 * Score area (SHA-163 N11 → SHA-170 N15a) — a PROJECTION of the N4 bench-state
 * cube, never a parallel structure. It reads the same `scores[evalKey][runId]`
 * cells the cube already holds and renders them at one of two cardinalities:
 *
 *   • 1 eval × 1 scored run → the simple TRAIL (a single current frac). This 1×1
 *     render is pixel-identical to N11 and is deliberately left untouched.
 *   • anything bigger (>1 run OR >1 eval) → the GRID: columns are the scored runs
 *     (the current run highlighted, last 3 by default + an "all runs" expander),
 *     rows are the evals (labels stamped with the version read from `state.evals`),
 *     and each cell is the rolled-up "n/m" frac (or "—" when unscored).
 *
 * This step is NUMBERS ONLY. Trust markers / the disputed indicator (N15b) and
 * the row/column navigation (N15c) are separate steps: the grid here reads the
 * score model and computes nothing new — no `agree` data, no peek, no scroll-to.
 *
 * Export sits beside the area and serializes the WHOLE cube + meta (model ids,
 * app version) — NOT the slice on screen. It round-trips through the N4 import
 * validator (`safeImportState`) before download, so a malformed export can never
 * leave the app.
 */

const NUM_RUNS_IN_TRAIL = 3
const NUM_RUNS_IN_GRID = 3

function labelFor(state: NotebookState, evalKey: string): string {
  if (evalKey === 'golden') return 'golden'
  return state.evals.find((e) => e.key === evalKey)?.label ?? evalKey
}

/** The eval's current version, for the "vN" row-label stamp (read from N16 state). */
function versionFor(state: NotebookState, evalKey: string): number {
  return state.evals.find((e) => e.key === evalKey)?.version ?? 1
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
  // The "all runs" expander only matters in the grid; declared up front so the
  // hook order is stable across the empty / simple / grid branches below.
  const [expandRuns, setExpandRuns] = useState(false)

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

  // The simple trail is reserved for the 1×1 case ONLY — exactly one eval scored
  // on exactly one run. ANY larger shape (>1 run OR >1 eval) expands into the grid.
  const scoredRuns = scoredRunsInOrder(state)
  const isSimple = evalKeys.length === 1 && scoredRuns.length === 1

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

      {isSimple ? (
        // ── 1×1 simple trail (pixel-identical to N11 — do not change) ──────────
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
      ) : (
        <ScoreGrid
          state={state}
          evalKeys={evalKeys}
          scoredRuns={scoredRuns}
          expandRuns={expandRuns}
          setExpandRuns={setExpandRuns}
        />
      )}
    </section>
  )
}

/**
 * The runs×evals grid — numbers only. Columns are the scored runs (current
 * highlighted, last 3 by default with an "all runs" expander); rows are the
 * evals (label stamped with the eval version from state); cells are the "n/m"
 * frac, or "—" when that (eval, run) pair was never scored. This reads the same
 * cube cells the trail does — it computes no new score.
 */
function ScoreGrid({
  state,
  evalKeys,
  scoredRuns,
  expandRuns,
  setExpandRuns,
}: {
  state: NotebookState
  evalKeys: string[]
  scoredRuns: ReturnType<typeof scoredRunsInOrder>
  expandRuns: boolean
  setExpandRuns: (v: boolean) => void
}) {
  // The current run is the most recent scored run (last in run order) — the same
  // run the simple trail marks "current". Highlighting follows it across columns.
  const currentRunId = scoredRuns[scoredRuns.length - 1]?.id
  const cols = expandRuns ? scoredRuns : scoredRuns.slice(-NUM_RUNS_IN_GRID)
  const hasOverflow = scoredRuns.length > NUM_RUNS_IN_GRID

  return (
    <div className={styles.scoreGridWrap} data-testid="score-grid">
      {hasOverflow && (
        <div className={styles.sgTop}>
          <button
            type="button"
            className={styles.sgExpander}
            data-testid="grid-expander"
            aria-pressed={expandRuns}
            onClick={() => setExpandRuns(!expandRuns)}
          >
            {expandRuns ? 'last 3 runs' : `all runs (${scoredRuns.length})`}
          </button>
        </div>
      )}

      <div
        className={styles.scoreGrid}
        style={{ gridTemplateColumns: `minmax(140px, 1.4fr) repeat(${cols.length}, 1fr)` }}
      >
        <div className={styles.sgCorner} aria-hidden="true" />
        {cols.map((run) => {
          const isCurrent = run.id === currentRunId
          return (
            <div
              key={run.id}
              className={`${styles.sgCol} ${isCurrent ? styles.sgColCur : ''}`}
              data-testid="grid-col"
              data-run-id={run.id}
              data-current={isCurrent ? 'true' : 'false'}
            >
              run {run.version}
              {isCurrent && <span className={styles.sgCur}>current</span>}
            </div>
          )
        })}

        {evalKeys.map((evalKey) => {
          const version = versionFor(state, evalKey)
          return (
            <div className={styles.sgRow} key={evalKey}>
              <div
                className={styles.sgRowLabel}
                data-testid="grid-row"
                data-eval-key={evalKey}
                data-version={version}
              >
                <span className={styles.sgRlMain}>{labelFor(state, evalKey)}</span>
                {version > 1 && <span className={styles.sgVer}>v{version}</span>}
              </div>
              {cols.map((run) => {
                const cell = state.scores[evalKey]?.[run.id]
                const isCurrent = run.id === currentRunId
                return (
                  <div
                    key={evalKey + run.id}
                    className={`${styles.sgCell} ${isCurrent ? styles.sgCellCur : ''} ${
                      cell ? '' : styles.sgCellEmpty
                    }`}
                    data-testid="grid-cell"
                    data-eval-key={evalKey}
                    data-run-id={run.id}
                  >
                    {cell ? cell.frac : '—'}
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
