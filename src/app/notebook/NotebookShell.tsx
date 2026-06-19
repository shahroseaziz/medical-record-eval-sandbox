'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BYO_MODEL, GENERATION_MODEL, modelDisplayName } from '@/lib/models'
import { PromptCell } from './PromptCell'
import { OutputCell } from './OutputCell'
import { EvalCell, type ScoreReport } from './EvalCell'
import { JudgeCell } from './JudgeCell'
import { ScoreLine } from './ScoreLine'
import { useNotebookRun } from './useNotebookRun'
import { useNotebookCube } from './useNotebookCube'
import { useWorkedExample } from './useWorkedExample'
import { WorkedExampleSection } from './WorkedExampleReplay'
import { ExplorerDrawer } from '@/components/explorer'
import { judgeCostLine, countJudgeable } from './judgeCost'
import { scoredEvalKeys } from '@/lib/notebook/state'
import type { NotebookPatient } from './types'
import styles from './notebook.module.css'

/** A judge added via "+ Add another eval" — the golden set never multiplies. */
interface AddedJudge {
  /** Stable per-judge id; also the cube key suffix (`judge:<id>`). */
  id: string
  evalKey: string
  label: string
}

/**
 * Notebook shell (SHA-156 N6) — the single-scroll sandbox surface: header
 * (wordmark · BYO-key slot · always-visible model identity), the data strip
 * (realism line + Explore button), and the empty section scaffolding (prompt →
 * output → eval → score) that later steps fill. Ships ALONGSIDE the existing
 * routes; cutover to `/` is N18.
 *
 * MODEL + CAPS (decided 2026-06-17 — a 2-state free/BYO toggle, NOT a picker):
 *   - No stored key  → ACTIVE model is GENERATION_MODEL (free tier), caps ON
 *     (shared limit, ≤5 patients per run).
 *   - A stored key   → ACTIVE model is BYO_MODEL (your key), caps LIFTED.
 * The model label is derived from the pinned id via `modelDisplayName` — never a
 * literal here — so it cannot drift from `lib/models.ts` (the single id source).
 */

/** The free tier's shared per-run patient ceiling. */
const FREE_TIER_PATIENT_CAP = 5

/**
 * sessionStorage key for the bring-your-own API key. Session-scoped and never
 * persisted to disk or sent to a server in this step — the key is held only for
 * the active tab so the shell can reflect the free/BYO toggle. Treated as a
 * secret: never logged.
 */
const BYO_KEY_STORAGE = 'mres.nb.byokey'

export function NotebookShell({ patientCount }: { patientCount: number | null }) {
  // ── Worked-example replay (N13b) ───────────────────────────────────────────
  // `?example=1` replays the committed artifact client-side with ZERO metered
  // calls. Read on mount (false on first render → no SSR/CSR mismatch); a real run
  // dismisses the on-ramp affordance. `useWorkedExample` only fetches while active.
  const [replayActive, setReplayActive] = useState(false)
  const [hasRealRun, setHasRealRun] = useState(false)
  const workedExample = useWorkedExample(replayActive)

  // The BYO key. Initialised empty for a deterministic first render (no SSR/CSR
  // mismatch); hydrated from sessionStorage on mount.
  const [apiKey, setApiKey] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  // Explore-the-data drawer (N7a shell + sortable table, N7b chart detail +
  // Parsed/Raw-XML toggle), wired here. A fixed-position slide-over: the Explore
  // button opens it to the all-patients table; an output/eval card's "view chart"
  // link opens it focused on that patient's chart. The notebook is NEVER unmounted
  // — the drawer is a fixed overlay and the notebook is merely padded to make room
  // (the N7a contract: in-progress prompt text survives an open/close cycle).
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [focusPatientId, setFocusPatientId] = useState<string | null>(null)

  const openExplorer = useCallback(() => {
    setFocusPatientId(null)
    setDrawerOpen(true)
  }, [])
  const openChart = useCallback((patientId: string) => {
    setFocusPatientId(patientId)
    setDrawerOpen(true)
  }, [])
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])

  // ── Prompt cell + run loop state (N8a) ─────────────────────────────────────
  const [prompt, setPrompt] = useState('')
  const [patients, setPatients] = useState<NotebookPatient[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [patientsError, setPatientsError] = useState<string | null>(null)
  // The patient order captured at Run time, so output cards render in the order
  // they were submitted even as selection changes afterwards.
  const [runOrder, setRunOrder] = useState<string[]>([])
  // The prompt captured at Run time, in STATE (not just a ref) so editing the
  // textarea afterwards re-renders the surface into its stale state.
  const [runPrompt, setRunPrompt] = useState('')
  const { results, running, runId, run, resume, spendCapped } = useNotebookRun()

  // ── The N4 bench-state cube (N11) ──────────────────────────────────────────
  // The single owner of a NotebookState. The score line is a PROJECTION of this
  // object and Export is the WHOLE object — so the trail on screen and the file
  // downloaded never diverge. Runs are snapshot here on completion; eval rows are
  // lifted up from the EvalCell and stamped with the current run id.
  const { state: cubeState, recordRun, recordScore, removeScore, replaceState } = useNotebookCube()

  // ── Multi-judge: "+ Add another eval" (N14) ────────────────────────────────
  // The golden set is SINGULAR — only judges multiply. Each added judge is its own
  // removable cell with its own cube key (`judge:<id>`). The primary EvalCell holds
  // the FIRST judge slot; the shell tracks its mode so the cost preview counts it
  // as a judge only while it actually is one.
  const [addedJudges, setAddedJudges] = useState<AddedJudge[]>([])
  const [primaryMode, setPrimaryMode] = useState<'golden' | 'judge' | null>(null)
  // Sequence starts at 1 (the primary judge); the first added judge is #2.
  const judgeSeqRef = useRef(1)

  const addJudge = useCallback(() => {
    judgeSeqRef.current += 1
    const n = judgeSeqRef.current
    const id = `j${n}`
    setAddedJudges((prev) => [...prev, { id, evalKey: `judge:${id}`, label: `LLM judge ${n}` }])
  }, [])

  const removeJudge = useCallback(
    (evalKey: string) => {
      // Drop the cell AND clean its scores from the cube — a removed judge leaves
      // no trace in state, the score line, or an export.
      setAddedJudges((prev) => prev.filter((j) => j.evalKey !== evalKey))
      removeScore(evalKey)
    },
    [removeScore],
  )
  // The prompt text used for the in-flight run, captured at Run time so the cube
  // records the prompt that produced the outputs (not a later edit).
  const runPromptRef = useRef('')
  const wasRunningRef = useRef(false)

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(BYO_KEY_STORAGE)
      if (stored) setApiKey(stored)
    } catch {
      // sessionStorage can throw in locked-down contexts — fall back to in-memory.
    }
  }, [])

  // Activate replay from `?example=1` after mount (kept off the first render so SSR
  // and the initial client render agree).
  useEffect(() => {
    try {
      setReplayActive(new URLSearchParams(window.location.search).get('example') === '1')
    } catch {
      // A non-browser / locked-down context simply never enters replay.
    }
  }, [])

  // Load a roster of patients to run against. Each carries its assembled stuff-mode
  // record (the run grounding) + light framing for the chips. The first is
  // pre-selected. A DB-less / empty environment degrades to an explained empty
  // state rather than a crash — the cell still renders, Run stays disabled.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/patients/sample?n=12')
        if (!res.ok) throw new Error('Could not load patients.')
        const data = (await res.json()) as {
          patients?: Array<{ id: string; name: string; summary: unknown; record: string; recordTokens: number }>
        }
        const roster: NotebookPatient[] = (data.patients ?? []).map((p) => {
          const s = (p.summary ?? {}) as Record<string, unknown>
          return {
            id: p.id,
            name: p.name,
            record: p.record,
            recordTokens: p.recordTokens,
            age: typeof s.age === 'number' ? s.age : null,
            sex: typeof s.sex === 'string' ? s.sex : '',
            conditionCount: typeof s.conditionCount === 'number' ? s.conditionCount : 0,
          }
        })
        if (cancelled) return
        setPatients(roster)
        // Pre-select exactly one patient by default (the locked chip).
        setSelected(roster.length ? [roster[0].id] : [])
        if (roster.length === 0) setPatientsError('No patients available to run against.')
      } catch (e) {
        if (cancelled) return
        setPatientsError(e instanceof Error ? e.message : 'Could not load patients.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onKeyChange = useCallback((value: string) => {
    setApiKey(value)
    try {
      if (value.trim()) window.sessionStorage.setItem(BYO_KEY_STORAGE, value)
      else window.sessionStorage.removeItem(BYO_KEY_STORAGE)
    } catch {
      // ignore — in-memory state still reflects the toggle.
    }
  }, [])

  const hasKey = apiKey.trim().length > 0
  // The two derived facts every downstream cell reads from this step:
  const activeModel = hasKey ? BYO_MODEL : GENERATION_MODEL
  const capsActive = !hasKey
  const tierLabel = hasKey ? 'your key' : 'free tier'

  // Stale-on-edit: the textarea no longer matches the prompt that produced the
  // current run, so its outputs + scores are stale. Pure client state — no engine
  // call; derived from `prompt !== the run's captured prompt`.
  const stale = runOrder.length > 0 && prompt.trim() !== runPrompt.trim()

  const patientsById = useMemo(() => new Map(patients.map((p) => [p.id, p])), [patients])
  const lockedId = patients.length ? patients[0].id : null
  // Show the "Load the worked example" on-ramp before the user has typed a prompt
  // AND before their first real run — it offers the worked example and is dismissed
  // once they have actually run something of their own (N13b).
  const showLoadExample = prompt.trim().length === 0 && !hasRealRun

  const onRun = useCallback(() => {
    const cases = selected
      .map((id) => patientsById.get(id))
      .filter((p): p is NotebookPatient => Boolean(p))
      .map((p) => ({ patientId: p.id, record: p.record }))
    if (cases.length === 0 || prompt.trim().length === 0) return
    // The user has now made a real run — dismiss the worked-example on-ramp.
    setHasRealRun(true)
    setRunOrder(cases.map((c) => c.patientId))
    // Capture the prompt that produced this run so the cube records it verbatim
    // even if the textarea is edited before the next run, and so the surface can
    // detect a later edit (stale-on-edit) by comparing against this snapshot.
    runPromptRef.current = prompt
    setRunPrompt(prompt)
    // The ACTIVE model id (imported, never a literal) is sent so the server records
    // and echoes back the model the user actually selected. The BYO key, if any, is
    // forwarded in-flight only (header) — never persisted by this call.
    void run(cases, prompt, { model: activeModel, byoKey: hasKey ? apiKey.trim() : undefined })
  }, [selected, patientsById, prompt, run, activeModel, hasKey, apiKey])

  // Snapshot a finished run into the cube as its own run column. Fires on the
  // running → idle edge so the cube captures the run's final outputs once.
  useEffect(() => {
    if (wasRunningRef.current && !running && runId > 0) {
      recordRun({
        runId: `run-${runId}`,
        version: runId,
        promptText: runPromptRef.current,
        order: runOrder,
        results,
        model: activeModel,
      })
    }
    wasRunningRef.current = running
  }, [running, runId, runOrder, results, activeModel, recordRun])

  // Receive a scored eval row from the EvalCell and write it into the CURRENT
  // run's column. The score line projects the cube from here — it is never a
  // separate structure the cell maintains.
  const onScoreReport = useCallback(
    (report: ScoreReport) => {
      if (runId <= 0) return
      recordScore(
        `run-${runId}`,
        { key: report.evalKey, label: report.label, criteriaOrGolden: report.criteriaOrGolden },
        report.row,
      )
    },
    [runId, recordScore],
  )

  // "+ Add another eval" appears ONLY after the first eval exists — i.e. once
  // anything (the golden or a judge) has been scored into the cube. This is the
  // deliberate 1×1 exception: the single on-ramp the simple path adds.
  const firstEvalExists = scoredEvalKeys(cubeState).length > 0

  // Cost preview fan-out: every judge runs once per gradeable patient, so a full
  // score pass costs `judges × patients` metered calls. The primary eval counts as
  // a judge only while it is in judge mode; added judges always count.
  const judgeCount = (primaryMode === 'judge' ? 1 : 0) + addedJudges.length
  const judgeablePatients = countJudgeable(runOrder, results)

  return (
    <div className={styles.app}>
      <header className={styles.appbar} data-testid="notebook-header">
        <div className={styles.brand}>
          <span className={styles.mark} data-testid="notebook-wordmark">
            M<span className={styles.dot} aria-hidden="true" />RES
          </span>
          <span className={styles.brandSub}>Medical-Record Eval Sandbox</span>
        </div>

        <div className={styles.appbarRight}>
          {/* Always-visible model identity — derived from lib/models.ts, truthful
              about the ACTIVE model. */}
          <span
            className={styles.modelBadge}
            data-testid="model-label"
            data-active-model={activeModel}
            data-caps-active={capsActive ? 'true' : 'false'}
          >
            <span className={styles.led} aria-hidden="true" />
            {modelDisplayName(activeModel)} · {tierLabel}
          </span>

          <div className={styles.apiKey}>
            <button
              type="button"
              className={styles.apiKeyBtn}
              data-testid="byo-key-toggle"
              aria-expanded={keyOpen}
              onClick={() => setKeyOpen((o) => !o)}
            >
              <span
                className={`${styles.keyDot} ${hasKey ? styles.keyDotOn : ''}`}
                aria-hidden="true"
              />
              {hasKey ? 'Your key' : 'Free tier'}
            </button>

            {keyOpen && (
              <div className={styles.apiKeyPop} data-testid="byo-key-popover">
                <div className={styles.akpTitle}>API key</div>
                <p className={styles.akpSub}>
                  Free tier runs {modelDisplayName(GENERATION_MODEL)} on a shared limit, up to{' '}
                  {FREE_TIER_PATIENT_CAP} patients. Your own key switches to{' '}
                  {modelDisplayName(BYO_MODEL)} and removes both caps.
                </p>
                <input
                  className={styles.akpInput}
                  data-testid="byo-key-input"
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="sk-ant-… (optional)"
                  aria-label="Anthropic API key"
                  value={apiKey}
                  onChange={(e) => onKeyChange(e.target.value)}
                />
                <div className={styles.akpFoot} data-testid="byo-key-foot">
                  {hasKey
                    ? `Key kept in this tab only · ${modelDisplayName(BYO_MODEL)}`
                    : `Using free tier · ${modelDisplayName(GENERATION_MODEL)}`}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={`${styles.notebook} ${drawerOpen ? styles.drawerOpen : ''}`}>
        <div className={styles.nbInner}>
          {/* ── Data strip ─────────────────────────────────────────────── */}
          <div className={styles.dataStrip} data-testid="data-strip">
            <p className={styles.dsLine} data-testid="realism-line">
              {patientCount != null ? (
                <>
                  <span className={styles.dsN}>{patientCount}</span> synthetic patient charts ·
                  Synthea C-CDA · fully synthetic, no real PHI.
                </>
              ) : (
                <>Synthetic patient charts · Synthea C-CDA · fully synthetic, no real PHI.</>
              )}
            </p>
            <div className={styles.dsRow2}>
              <span className={styles.dsNote}>
                Synthetic charts are cleaner than real ones — a prompt that works here still meets
                messier records in production.
              </span>
              <button
                type="button"
                className={`${styles.exploreBtn} ${drawerOpen ? styles.exploreOn : ''}`}
                data-testid="explore-button"
                aria-expanded={drawerOpen}
                aria-controls="explorer-drawer"
                onClick={openExplorer}
              >
                Explore the data
              </button>
            </div>
          </div>

          {replayActive ? (
            <WorkedExampleSection
              status={workedExample.status}
              artifact={workedExample.artifact}
              message={workedExample.message}
            />
          ) : (
          <>
          {/* ── Section scaffolding (document order; later steps fill these) ── */}
          <PromptCell
            prompt={prompt}
            setPrompt={setPrompt}
            patients={patients}
            selected={selected}
            setSelected={setSelected}
            lockedId={lockedId}
            hasKey={hasKey}
            running={running}
            onRun={onRun}
            showLoadExample={showLoadExample}
            loadError={patientsError}
          />

          <OutputCell
            order={runOrder}
            results={results}
            patientsById={patientsById}
            onViewChart={openChart}
            stale={stale}
            onResume={(id) =>
              void resume(id, {
                model: activeModel,
                byoKey: hasKey ? apiKey.trim() : undefined,
              })
            }
            // BYO bypasses the shared spend cap, so once a key is present the cap
            // panel no longer applies — the preserved prompt/patients are ready to
            // re-run on the user's own key.
            spendCapped={spendCapped && !hasKey}
            onAddKey={() => setKeyOpen(true)}
          />

          <EvalCell
            order={runOrder}
            results={results}
            patientsById={patientsById}
            onViewChart={openChart}
            byoKey={hasKey ? apiKey.trim() : undefined}
            onScoreReport={onScoreReport}
            onModeChange={setPrimaryMode}
            stale={stale}
          />

          {/* Added judges (N14) — each its own removable cell; the golden stays
              singular. Removing one cleans its scores from the cube. */}
          {addedJudges.map((j) => (
            <JudgeCell
              key={j.id}
              evalKey={j.evalKey}
              label={j.label}
              order={runOrder}
              results={results}
              patientsById={patientsById}
              byoKey={hasKey ? apiKey.trim() : undefined}
              hasKey={hasKey}
              onScoreReport={onScoreReport}
              onRemove={() => removeJudge(j.evalKey)}
            />
          ))}

          {/* The single on-ramp the 1×1 path adds: it appears only after the first
              eval is scored, and it adds JUDGES — never a second golden. */}
          {firstEvalExists && (
            <div className={styles.addEval} data-testid="add-eval">
              {addedJudges.length > 0 && judgeCount > 0 && (
                <div className={styles.runNote} data-testid="judge-cost-preview">
                  {judgeCostLine(judgeCount, judgeablePatients, hasKey)}
                </div>
              )}
              <button
                type="button"
                className={styles.addEvalBtn}
                data-testid="add-eval-button"
                onClick={addJudge}
              >
                <span aria-hidden="true">+</span> Add another eval
                <span className={styles.addEvalHint}>
                  another judge — a judge is just another criteria box
                </span>
              </button>
            </div>
          )}

          <ScoreLine state={cubeState} onImport={replaceState} />
          </>
          )}

          <div className={styles.nbEnd} aria-hidden="true" />
        </div>
      </main>

      {/* The Explore-the-data drawer (N7a/N7b). A fixed-position slide-over: it
          never participates in the notebook's layout and never remounts it — the
          notebook above is merely padded (.drawerOpen) to make room. The Explore
          button opens it to the table; a card's "view chart" opens it focused on
          that patient's chart via focusPatientId. */}
      <ExplorerDrawer open={drawerOpen} onClose={closeDrawer} focusPatientId={focusPatientId} />
    </div>
  )
}
