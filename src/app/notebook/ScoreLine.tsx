'use client'

import { useCallback, useRef, useState } from 'react'
import {
  projectEvalTrail,
  safeImportState,
  scoredEvalKeys,
  scoredRunsInOrder,
  serializeState,
  type NotebookState,
} from '@/lib/notebook/state'
import { hasDisputedVerdict, judgeRowMarkers } from './judgeAgreement'
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
 * GRID NAVIGATION (N15c) lives on the grid only — the 1×1 trail is left exactly as
 * N11 left it (the identity test in `e2e/score-identity.test.ts` pins that path to
 * pixels). Two moves:
 *   • a ROW LABEL is a button → scrolls to that eval's editor (golden → the Eval
 *     cell, a judge → its judge cell), using a TIMED-STEPPER scroll, never native
 *     `scroll-behavior: smooth` (which silently no-ops in some webviews).
 *   • a COLUMN HEADER is a button → toggles a read-only PEEK at that run's prompt.
 *
 * Numbers + navigation only. Trust markers / the disputed indicator (N15b) still
 * read no new score here — the grid computes nothing the cube does not already hold.
 * SHA-170 N15a was numbers only. SHA-171 N15b adds, on the grid ONLY, the
 * current-column trust markers per JUDGE row ("vs your golden m/n" overlap + the
 * "you: a/m" of-marked agreement) and the disputed-cell indicator — both derived
 * SOLELY from N4 state already on the cube (golden `per[]` + the `agree` marks);
 * golden rows carry no markers and the row/column navigation (N15c) is still later.
 *
 * Export sits beside the area and serializes the WHOLE cube + meta (model ids,
 * app version) — NOT the slice on screen. It round-trips through the N4 import
 * validator (`safeImportState`) before download, so a malformed export can never
 * leave the app.
 */

const NUM_RUNS_IN_TRAIL = 3
const NUM_RUNS_IN_GRID = 3

// Timed-stepper scroll tuning. We do NOT use `scrollIntoView`/native smooth scroll:
// it disrupts layout and silently no-ops in some webviews (the documented reason the
// native path was dropped). Instead we animate `window.scrollY` ourselves in fixed
// increments — a manual ease that behaves identically everywhere a timer fires.
const SCROLL_START_DELAY_MS = 110 // let any layout/mode switch settle before measuring
const SCROLL_STEPS = 26
const SCROLL_STEP_MS = 14
const SCROLL_TOP_OFFSET = 76 // leave the sticky header's worth of room above the target

/** easeInOutQuad — the per-step progress curve for the timed-stepper scroll. */
function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

/**
 * Resolve the on-page editor element for an eval key. The golden eval is the Eval
 * cell (`section-eval`); an added judge is its own cell, tagged with `data-eval-key`.
 * Returns null when the editor is not mounted (defensive — the caller no-ops).
 */
function editorElementFor(evalKey: string): HTMLElement | null {
  const selector =
    evalKey === 'golden'
      ? '[data-testid="section-eval"]'
      : `[data-eval-key="${CSS.escape(evalKey)}"]`
  return document.querySelector<HTMLElement>(selector)
}

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
 * A timed-stepper scroll-to-editor callback. Animates `window.scrollY` toward the
 * resolved editor element in fixed increments — deliberately NOT `scrollIntoView`
 * or native smooth scroll (which no-op in some webviews). Pending step timers are
 * tracked so a re-trigger or unmount cancels the in-flight animation cleanly.
 */
function useScrollToEditor(): (evalKey: string) => void {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const cancel = useCallback(() => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }, [])

  return useCallback(
    (evalKey: string) => {
      cancel()
      // A short settle delay: the target may have just mounted/expanded, so measure
      // its position after layout, not before.
      timers.current.push(
        setTimeout(() => {
          const el = editorElementFor(evalKey)
          if (!el) return
          const start = window.scrollY
          const target = Math.max(
            0,
            el.getBoundingClientRect().top + window.scrollY - SCROLL_TOP_OFFSET,
          )
          const dist = target - start
          if (Math.abs(dist) < 2) return
          for (let i = 1; i <= SCROLL_STEPS; i++) {
            timers.current.push(
              setTimeout(() => {
                window.scrollTo(0, start + dist * easeInOutQuad(i / SCROLL_STEPS))
              }, i * SCROLL_STEP_MS),
            )
          }
        }, SCROLL_START_DELAY_MS),
      )
    },
    [cancel],
  )
}

/**
 * The runs×evals grid — numbers + navigation. Columns are the scored runs (current
 * highlighted, last 3 by default with an "all runs" expander); rows are the evals
 * (label stamped with the eval version from state); cells are the "n/m" frac, or
 * "—" when that (eval, run) pair was never scored. This reads the same cube cells
 * the trail does — it computes no new score.
 *
 * Navigation (N15c): a row label scrolls to that eval's editor (timed-stepper), and
 * a column header toggles a read-only peek at that run's prompt.
 * The runs×evals grid. Columns are the scored runs (current highlighted, last 3 by
 * default with an "all runs" expander); rows are the evals (label stamped with the
 * eval version from state); cells are the "n/m" frac, or "—" when that (eval, run)
 * pair was never scored.
 *
 * N15b adds, derived purely from the cube already on screen:
 *   • per JUDGE row, a CURRENT-column secondary line — "vs your golden m/n" (the
 *     judge↔golden overlap on the current run) and "you: a/m" (of-MARKED agreement).
 *     Golden rows carry none.
 *   • a disputed-cell mark on any cell holding a disagreed verdict (`agree==='m'`),
 *     sourced SOLELY from the `agree` marks.
 * Both read existing cube state — they compute no new score.
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

  const scrollToEditor = useScrollToEditor()

  // The run whose prompt is currently peeked open (null = closed). Column headers
  // toggle this; the peek is read-only — it shows the prompt, it never edits it.
  const [peekRunId, setPeekRunId] = useState<string | null>(null)
  const peekRun = peekRunId ? scoredRuns.find((r) => r.id === peekRunId) ?? null : null

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

      {peekRun && (
        <div className={styles.runPeek} data-testid="run-peek" data-run-id={peekRun.id}>
          <div className={styles.rpHead}>
            <span className={styles.rpTitle}>run {peekRun.version} · prompt</span>
            <button
              type="button"
              className={styles.rpClose}
              data-testid="run-peek-close"
              aria-label="Close prompt peek"
              onClick={() => setPeekRunId(null)}
            >
              ✕
            </button>
          </div>
          {/* Read-only: a <pre> of the recorded prompt, never an editable field. */}
          <pre className={styles.rpBody} data-testid="run-peek-prompt">
            {peekRun.promptText.trim() ? peekRun.promptText : '(empty prompt)'}
          </pre>
        </div>
      )}

      <div
        className={styles.scoreGrid}
        style={{ gridTemplateColumns: `minmax(140px, 1.4fr) repeat(${cols.length}, 1fr)` }}
      >
        <div className={styles.sgCorner} aria-hidden="true" />
        {cols.map((run) => {
          const isCurrent = run.id === currentRunId
          const isOpen = run.id === peekRunId
          return (
            <button
              key={run.id}
              type="button"
              className={`${styles.sgCol} ${isCurrent ? styles.sgColCur : ''} ${
                isOpen ? styles.sgColOpen : ''
              }`}
              data-testid="grid-col"
              data-run-id={run.id}
              data-current={isCurrent ? 'true' : 'false'}
              aria-pressed={isOpen}
              title="show this run's prompt"
              onClick={() => setPeekRunId(isOpen ? null : run.id)}
            >
              run {run.version}
              {isCurrent && <span className={styles.sgCur}>current</span>}
            </button>
          )
        })}

        {evalKeys.map((evalKey) => {
          const version = versionFor(state, evalKey)
          // Trust markers reflect the CURRENT column only, and JUDGE rows only —
          // a golden row has no judge-vs-golden and no agree of its own. Read the
          // current run's judge `per[]` and (when scored) the golden `per[]` for
          // the SAME run; the derivation lives in judgeAgreement (pure, tested).
          const markers =
            evalKey === 'golden'
              ? []
              : judgeRowMarkers(
                  state.scores[evalKey]?.[currentRunId]?.per ?? [],
                  state.scores.golden?.[currentRunId]?.per,
                )
          return (
            <div className={styles.sgRow} key={evalKey}>
              <button
                type="button"
                className={styles.sgRowLabel}
                data-testid="grid-row"
                data-eval-key={evalKey}
                data-version={version}
                title="go to this eval's editor"
                onClick={() => scrollToEditor(evalKey)}
              >
                <span className={styles.sgRlMain}>{labelFor(state, evalKey)}</span>
                {version > 1 && <span className={styles.sgVer}>v{version}</span>}
                {markers.length > 0 && (
                  <span className={styles.sgRlMarkers} data-testid="row-markers">
                    {markers.map((m) => (
                      <span
                        key={m.kind}
                        className={`${styles.sgMarker} ${
                          m.kind === 'vg' ? styles.sgMarkerVg : styles.sgMarkerYou
                        }`}
                        data-testid={`marker-${m.kind}`}
                      >
                        {m.text}
                      </span>
                    ))}
                  </span>
                )}
              </button>
              {cols.map((run) => {
                const cell = state.scores[evalKey]?.[run.id]
                const isCurrent = run.id === currentRunId
                // A cell is disputed iff it holds a verdict the user marked disagree
                // (`agree === 'm'`) — derived SOLELY from the `agree` marks.
                const disputed = cell ? hasDisputedVerdict(cell.per) : false
                return (
                  <div
                    key={evalKey + run.id}
                    className={`${styles.sgCell} ${isCurrent ? styles.sgCellCur : ''} ${
                      cell ? '' : styles.sgCellEmpty
                    }`}
                    data-testid="grid-cell"
                    data-eval-key={evalKey}
                    data-run-id={run.id}
                    data-disputed={disputed ? 'true' : 'false'}
                  >
                    {cell ? cell.frac : '—'}
                    {disputed && (
                      <span
                        className={styles.sgDispute}
                        data-testid="disputed-cell"
                        title="disputed — you marked a verdict here"
                        aria-label="disputed"
                      >
                        ⚑
                      </span>
                    )}
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
