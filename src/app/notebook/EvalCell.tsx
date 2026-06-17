'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { modelDisplayName } from '@/lib/models'
import type { PerCaseScore, ScoreRow } from '@/lib/notebook/state'
import type { OutputCardResult } from './useNotebookRun'
import { useNotebookJudge, type JudgeVerdict, type JudgeCase } from './useNotebookJudge'
import type { NotebookPatient } from './types'
import { gradeGolden, type GoldenGrade } from './goldenGrade'
import {
  computeJudgeVsGolden,
  computeYouVsJudge,
  type AgreeMark,
} from './judgeAgreement'
import { WORKED_CRITERIA } from './worked-example'
import styles from './notebook.module.css'

/** The notebook's single LLM-judge eval key (`judge:<id>` per the N4 schema). */
const JUDGE_EVAL_KEY = 'judge:default'

/**
 * Build the per-case golden score rows, EXCLUDING stale entries from the pass/fail
 * denominator. A stale entry (its output predates the current prompt) is marked
 * `errored: true` — the SAME exclusion the judge already uses for un-gradable
 * patients (see JudgeResults) — so a stale output is never counted pass OR fail.
 * The cube denominator (`per.filter(p => p.pass !== undefined)`) drops it.
 *
 * Pure + exported so the stale-exclusion is unit-testable on its own.
 */
export function buildGoldenPerCase(
  order: string[],
  grades: Record<string, GoldenGrade | undefined>,
  stale: ReadonlySet<string>,
): PerCaseScore[] {
  return order.map((id) => {
    // Stale → excluded (errored), regardless of how it graded under the old prompt.
    if (stale.has(id)) {
      return { patientId: id, errored: true, fails: [] }
    }
    const g = grades[id]
    const graded = g != null && (g.state === 'pass' || g.state === 'fail')
    return {
      patientId: id,
      ...(graded ? { pass: g!.state === 'pass' } : { errored: true }),
      fails: g ? g.fails.map((f) => f.field) : [],
      ...(g?.error ? { reason: g.error } : {}),
    }
  })
}

/**
 * A scored eval row lifted up to the cube owner. The shell stamps the current run
 * id onto it; this carries only the eval identity + the rolled-up row, so the cube
 * stays the single source the score line projects from.
 */
export interface ScoreReport {
  evalKey: string
  label: string
  criteriaOrGolden: string
  row: ScoreRow
}

/**
 * Eval cell — golden answers (SHA-161 N9). The FIRST eval layer.
 *
 * The invite is deliberately NO-CHOOSER: a single primary "Add golden answers"
 * action plus a quieter "or use an LLM judge" link. The judge path is N10 — its
 * link reveals a live, defined stub here rather than a dead control.
 *
 * Scoring is CLIENT-SIDE and DETERMINISTIC via `lib/eval/normalize` (wired through
 * ./goldenGrade): a patient PASSES iff every field present in its golden matches
 * the model output AFTER normalization (case / whitespace / list-order / clinical
 * aliases). Fields ABSENT from the golden are not graded — a partial golden grades
 * partially. ZERO metered calls, zero server state: pressing "Score" runs pure
 * functions, never the network.
 */

const GOLDEN_PLACEHOLDER = `{
  "a1c_current": …,
  "a1c_trend": "…",
  "diabetes_meds": […]
}`

interface GoldenRowProps {
  patient: NotebookPatient | undefined
  patientId: string
  value: string
  onChange: (value: string) => void
  grade: GoldenGrade | undefined
  onViewChart: (patientId: string) => void
}

function GoldenRow({ patient, patientId, value, onChange, grade, onViewChart }: GoldenRowProps) {
  const [expanded, setExpanded] = useState(false)
  const name = patient?.name ?? patientId
  const state = grade?.state

  return (
    <div className={styles.goldenRow} data-testid="golden-editor" data-patient-id={patientId}>
      <div className={styles.grSide}>
        <span className={styles.grName}>{name}</span>
        <button
          type="button"
          className={styles.linkBtn}
          data-testid="golden-open-chart"
          onClick={() => onViewChart(patientId)}
        >
          open chart
        </button>

        {state === 'pass' && (
          <span
            className={`${styles.goldenVerdict} ${styles.gvPass}`}
            data-testid="golden-verdict"
            data-verdict="pass"
          >
            pass
          </span>
        )}
        {state === 'fail' && (
          <button
            type="button"
            className={styles.failChip}
            data-testid="golden-fail-chip"
            data-verdict="fail"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
          >
            ≠ {grade!.fails.map((f) => f.field).join(', ')}
            <span className={styles.chev} aria-hidden="true">
              {expanded ? '▴' : '▾'}
            </span>
          </button>
        )}
        {state === 'invalid' && (
          <span className={styles.grNote} data-testid="golden-invalid">
            {grade!.error}
          </span>
        )}
        {state === 'nooutput' && (
          <span className={styles.grNote}>run the prompt to score this patient</span>
        )}
      </div>

      <textarea
        className={`${styles.goldenIn} ${state === 'pass' ? styles.goldenOk : ''} ${
          state === 'fail' ? styles.goldenBad : ''
        }`}
        data-testid="golden-input"
        value={value}
        spellCheck={false}
        placeholder={GOLDEN_PLACEHOLDER}
        onChange={(e) => onChange(e.target.value)}
      />

      {state === 'fail' && expanded && (
        <div className={styles.goldenDiff} data-testid="golden-diff">
          <div className={styles.gdHead}>
            <span>field</span>
            <span>expected (your golden)</span>
            <span>got (model)</span>
          </div>
          {grade!.fails.map((f) => (
            <div className={styles.gdRow} key={f.field}>
              <span className={styles.gdField}>{f.field}</span>
              <span className={styles.gdExp}>{f.expected}</span>
              <span className={styles.gdGot}>{f.got}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Judge verdicts — per-patient pass/fail + reason, plus the honest overall ──
//
// DECISION D1: each verdict is a single binary pass/fail. Judge-ERRORED patients
// are EXCLUDED from the denominator (not a silent drop, not a fake fail): they
// render the exact "couldn't grade — excluded from the score" copy and the overall
// counts only the patients that actually got a verdict. The number is the JUDGE's
// own pass count — the do-you-agree thumbs (N17) are never folded in.
interface JudgeResultsProps {
  order: string[]
  verdicts: Record<string, JudgeVerdict>
  patientsById: Map<string, NotebookPatient>
  /** The do-you-agree marks the user has pressed on judge rows, by patient id. */
  agree: Record<string, AgreeMark>
  /** Toggle the agree mark on one judge verdict (re-pressing clears it). */
  onToggleAgree: (patientId: string, mark: AgreeMark) => void
  /**
   * The golden grades from this run, if the user also scored a golden — the source
   * for the judge-vs-golden overlap line. Empty when no golden has been scored.
   */
  goldenScores: Record<string, GoldenGrade> | null
}

export function JudgeResults({
  order,
  verdicts,
  patientsById,
  agree,
  onToggleAgree,
  goldenScores,
}: JudgeResultsProps) {
  const settled = order.map((id) => verdicts[id]).filter((v): v is JudgeVerdict => Boolean(v))

  // ── N4-shaped per[] arrays — the source the two derived lines read from ──────
  // Building the judge/golden rows in the committed `PerCaseScore` shape (judge
  // verdict on `state`, golden verdict on `pass`, the thumb on `agree`) keeps this
  // a pure projection of the cube: the agreement signal can be lifted into `scores`
  // later with no translation. The thumb is NEVER read into the pass count below.
  const judgePer: PerCaseScore[] = settled.map((v) =>
    v.status === 'done'
      ? {
          patientId: v.patientId,
          state: v.pass ? 'pass' : 'fail',
          fails: [],
          reason: v.reason ?? undefined,
          agree: agree[v.patientId],
        }
      : { patientId: v.patientId, errored: v.status === 'errored', fails: [] },
  )
  const goldenPer: PerCaseScore[] = goldenScores
    ? Object.entries(goldenScores)
        .filter(([, g]) => g.state === 'pass' || g.state === 'fail')
        .map(([patientId, g]) => ({ patientId, pass: g.state === 'pass', fails: [] }))
    : []

  const youVsJudge = computeYouVsJudge(judgePer)
  const judgeVsGolden = computeJudgeVsGolden(judgePer, goldenPer)

  if (settled.length === 0) return null

  // Scored = patients that actually received a verdict. Errored patients are
  // excluded from this denominator entirely.
  const scored = settled.filter((v) => v.status === 'done')
  const erroredN = settled.filter((v) => v.status === 'errored').length
  const passN = scored.filter((v) => v.pass === true).length
  // The model stamp is the producing judge id, read off any settled verdict.
  const stampModel = settled.find((v) => v.model)?.model ?? null

  return (
    <div data-testid="judge-results">
      <div className={styles.judgeRows}>
        {settled.map((v) => {
          const name = patientsById.get(v.patientId)?.name ?? v.patientId

          if (v.status === 'judging' || v.status === 'pending') {
            return (
              <div className={styles.judgeRow} key={v.patientId} data-patient-id={v.patientId}>
                <div className={styles.jrHead}>
                  <span className={styles.jrName}>{name}</span>
                  <span className={styles.jrPending}>judging…</span>
                </div>
              </div>
            )
          }

          if (v.status === 'errored') {
            return (
              <div
                className={`${styles.judgeRow} ${styles.judgeRowErr}`}
                key={v.patientId}
                data-patient-id={v.patientId}
                data-verdict="errored"
                data-testid="judge-verdict-errored"
              >
                <div className={styles.jrHead}>
                  <span className={styles.jrName}>{name}</span>
                  <span className={`${styles.judgeVerdict} ${styles.jvErr}`}>
                    couldn&apos;t grade — excluded from the score
                  </span>
                </div>
                {/* No fabricated reason on error: we show the failure, not a verdict. */}
                <div className={`${styles.jrReason} ${styles.jrReasonDim}`}>
                  The judge call failed for this patient. It is left out of the number below — re-run
                  the judge to score it.
                </div>
              </div>
            )
          }

          // status === 'done' — a real binary verdict + the judge's own reason.
          return (
            <div
              className={styles.judgeRow}
              key={v.patientId}
              data-patient-id={v.patientId}
              data-verdict={v.pass ? 'pass' : 'fail'}
              data-testid="judge-verdict"
            >
              <div className={styles.jrHead}>
                <span className={styles.jrName}>{name}</span>
                <span
                  className={`${styles.judgeVerdict} ${v.pass ? styles.jvPass : styles.jvFail}`}
                >
                  {v.pass ? 'pass' : 'fail'}
                </span>
                {v.model && (
                  <span className={styles.jrModel} data-testid="judge-model-stamp">
                    judged by {modelDisplayName(v.model)}
                  </span>
                )}

                {/* Do-you-agree thumbs — JUDGE ROWS ONLY. Writes `agree` ('a'|'m')
                    onto the score entry; never folded into the pass count above. */}
                <span className={styles.agreeWrap} data-testid="agree-thumbs">
                  <span className={styles.agreeLabel}>do you agree?</span>
                  <button
                    type="button"
                    className={`${styles.agreeBtn} ${agree[v.patientId] === 'a' ? styles.agreeYes : ''}`}
                    data-testid="agree-yes"
                    data-on={agree[v.patientId] === 'a' ? 'true' : 'false'}
                    aria-pressed={agree[v.patientId] === 'a'}
                    onClick={() => onToggleAgree(v.patientId, 'a')}
                  >
                    agree
                  </button>
                  <button
                    type="button"
                    className={`${styles.agreeBtn} ${agree[v.patientId] === 'm' ? styles.agreeNo : ''}`}
                    data-testid="agree-no"
                    data-on={agree[v.patientId] === 'm' ? 'true' : 'false'}
                    aria-pressed={agree[v.patientId] === 'm'}
                    onClick={() => onToggleAgree(v.patientId, 'm')}
                  >
                    disagree
                  </button>
                </span>
              </div>
              <div className={styles.jrReason}>{v.reason}</div>
            </div>
          )
        })}
      </div>

      {scored.length + erroredN > 0 && (
        <div className={styles.goldenOverall} data-testid="judge-overall">
          <span className={styles.ovNum}>
            {passN}/{scored.length}
          </span>{' '}
          pass
          <span className={styles.ovNote}>
            {stampModel ? ` · judged by ${modelDisplayName(stampModel)}` : ''}
            {erroredN > 0 ? ` · ${erroredN} couldn't grade — excluded from the score` : ''}
          </span>
        </div>
      )}

      {/* judge-vs-golden — the overlap where a judge AND the golden both scored the
          same patient. A plain client-side count: no metered call, no kappa. */}
      {judgeVsGolden.overlap > 0 && (
        <div className={styles.crossLine} data-testid="judge-vs-golden">
          <div className={styles.clMain}>
            The judge matched your golden answers on{' '}
            <span className={styles.ovNum}>
              {judgeVsGolden.matched} of {judgeVsGolden.overlap}
            </span>{' '}
            patient{judgeVsGolden.overlap === 1 ? '' : 's'}.
          </div>
          <div className={styles.clSub}>
            A mismatch is a lead, not a verdict — sometimes the judge is right and your golden
            answer is stale.
          </div>
        </div>
      )}

      {/* you: a/m — agreed among MARKED (of-marked denominator, never of-scored). */}
      {youVsJudge.marked > 0 && (
        <div className={styles.youVsJudge} data-testid="judge-you-vs">
          <span className={styles.ovNum}>
            you: {youVsJudge.agreed}/{youVsJudge.marked}
          </span>
          <span className={styles.ovNote}>
            {' '}
            agreed with the judge, of the {youVsJudge.marked} verdict
            {youVsJudge.marked === 1 ? '' : 's'} you marked
          </span>
        </div>
      )}
    </div>
  )
}

export interface EvalCellProps {
  /** Patient ids in the order the current run submitted them. */
  order: string[]
  results: Record<string, OutputCardResult>
  patientsById: Map<string, NotebookPatient>
  onViewChart: (patientId: string) => void
  /**
   * BYO Anthropic key, forwarded to the judge call in-flight only (never logged).
   * Present → judge calls run on the user's key with the free-tier caps lifted.
   */
  byoKey?: string
  /**
   * Lift a scored eval row up to the cube owner (the shell). Fired on golden
   * Score and once a judge settles. The shell stamps the current run id; the
   * score line then PROJECTS the cube — this cell never renders the trail itself.
   */
  onScoreReport?: (report: ScoreReport) => void
  /**
   * Notify the owner of this PRIMARY eval's current mode (N14). The shell counts
   * the primary as a judge for the multi-judge cost preview only when it is in
   * judge mode — so the previewed fan-out tracks what will actually run.
   */
  onModeChange?: (mode: 'golden' | 'judge' | null) => void
  /**
   * The current prompt differs from the one that produced this run — the outputs
   * are STALE. Scoring is disabled ("Re-run to score"), the existing score is
   * quieted, and any entry scored while stale drops from the denominator. Pure
   * client state; defaults to false.
   */
  stale?: boolean
}

type Mode = null | 'golden' | 'judge'

export function EvalCell({
  order,
  results,
  patientsById,
  onViewChart,
  byoKey,
  onScoreReport,
  onModeChange,
  stale = false,
}: EvalCellProps) {
  const [mode, setMode] = useState<Mode>(null)
  const [golden, setGolden] = useState<Record<string, string>>({})
  // The plain-language judge criteria the user writes (judge mode). A judge is a
  // prompt — this box IS that prompt.
  const [criteria, setCriteria] = useState('')
  const { verdicts, judging, runJudge, judgeRunId } = useNotebookJudge()
  // Do-you-agree marks, by patient id ('a' = agreed, 'm' = marked-disagree). The
  // SOLE source for the "you: a/m" line and the later disputed-cell indicator —
  // held separately from the verdict so it is never folded into the pass count.
  const [agree, setAgree] = useState<Record<string, AgreeMark>>({})
  // The scored snapshot — null until "Score" is pressed. Holding a snapshot (vs.
  // grading live on every keystroke) keeps the verdicts stable while the user
  // edits, and makes "Score" a discrete, observable, network-free action.
  const [scores, setScores] = useState<Record<string, GoldenGrade> | null>(null)

  const hasOutput = order.some((id) => results[id]?.status === 'done')

  // Mirror the primary eval's mode up so the shell's multi-judge cost preview can
  // count the primary as a judge only while it is actually a judge.
  useEffect(() => {
    onModeChange?.(mode)
  }, [mode, onModeChange])

  const setOne = useCallback((id: string, value: string) => {
    setGolden((g) => ({ ...g, [id]: value }))
  }, [])

  // CLIENT-SIDE scoring: pure functions over local state. No fetch, no metered
  // call — grading a golden never touches the network. Disabled while stale (the
  // outputs predate the prompt) — "Re-run to score".
  const onScore = useCallback(() => {
    if (stale) return
    const next: Record<string, GoldenGrade> = {}
    for (const id of order) {
      const r = results[id]
      next[id] = gradeGolden(golden[id] ?? '', r?.output, r?.status === 'done')
    }
    setScores(next)

    // Lift the golden row into the cube. Only pass/fail patients count toward the
    // denominator — invalid/no-output golds AND stale entries are `errored`
    // (excluded), matching the displayed overall. The score line projects this; it
    // is not computed there.
    if (onScoreReport) {
      // Stale outputs never count pass/fail. When the whole run is stale every
      // entry is excluded; the same helper drops any subset of stale ids.
      const staleSet = stale ? new Set(order) : new Set<string>()
      const per = buildGoldenPerCase(order, next, staleSet)
      const gradedTotal = per.filter((p) => p.pass !== undefined).length
      const passN = per.filter((p) => p.pass === true).length
      onScoreReport({
        evalKey: 'golden',
        label: 'Golden set',
        criteriaOrGolden: JSON.stringify(golden),
        row: { frac: `${passN}/${gradedTotal}`, per },
      })
    }
  }, [order, results, golden, onScoreReport, stale])

  // Lift the judge row into the cube once a run of verdicts settles (no longer
  // judging, at least one verdict in). Errored patients are `errored` (excluded
  // from the denominator), mirroring the judge overall above.
  useEffect(() => {
    if (!onScoreReport || judging) return
    const settled = order
      .map((id) => verdicts[id])
      .filter((v): v is JudgeVerdict => Boolean(v) && (v.status === 'done' || v.status === 'errored'))
    if (settled.length === 0) return
    const per: PerCaseScore[] = settled.map((v) => ({
      patientId: v.patientId,
      ...(v.status === 'done' ? { state: v.pass ? 'pass' : 'fail' } : { errored: true }),
      fails: [],
      ...(v.reason ? { reason: v.reason } : {}),
    }))
    const scored = settled.filter((v) => v.status === 'done')
    const passN = scored.filter((v) => v.pass === true).length
    onScoreReport({
      evalKey: JUDGE_EVAL_KEY,
      label: 'LLM judge',
      criteriaOrGolden: criteria,
      row: { frac: `${passN}/${scored.length}`, per },
    })
  }, [verdicts, judging, order, criteria, onScoreReport])

  const overall = useMemo(() => {
    if (!scores) return null
    const graded = order.filter((id) => {
      const s = scores[id]?.state
      return s === 'pass' || s === 'fail'
    })
    const passN = graded.filter((id) => scores[id]?.state === 'pass').length
    return { passN, total: graded.length }
  }, [scores, order])

  // ── Judge invocation: EXACTLY one metered call per patient ──────────────────
  // One POST /api/score (criteria contract) per patient that produced output — the
  // two-call faithfulness pipeline is never reached from here. Patients without a
  // completed output have nothing to judge and are skipped (no wasted call).
  const onJudge = useCallback(() => {
    if (!criteria.trim() || stale) return
    const cases: JudgeCase[] = order
      .map((id) => results[id])
      .filter((r): r is OutputCardResult => Boolean(r) && r.status === 'done' && r.output.trim().length > 0)
      .map((r) => ({ patientId: r.patientId, output: r.output }))
    if (cases.length === 0) return
    void runJudge(cases, criteria, { byoKey })
  }, [criteria, order, results, runJudge, byoKey, stale])

  // A fresh judge run produces fresh verdicts, so prior agree marks no longer apply
  // — clear them when the run id bumps (the first run goes 0 → 1, also clearing).
  useEffect(() => {
    setAgree({})
  }, [judgeRunId])

  // Toggle one thumb: re-pressing the active mark clears it, so a mis-click is
  // undoable and "marked" reflects a deliberate opinion.
  const onToggleAgree = useCallback((patientId: string, mark: AgreeMark) => {
    setAgree((prev) => {
      const next = { ...prev }
      if (next[patientId] === mark) delete next[patientId]
      else next[patientId] = mark
      return next
    })
  }, [])

  // Before any run there is nothing to grade against — keep the section present
  // (the scaffolding) but quiet.
  if (!hasOutput) {
    return (
      <section className={styles.cell} data-testid="section-eval" aria-label="Eval">
        <span className={styles.cellLabel}>Eval</span>
        <p className={styles.cellPlaceholder}>
          Run the prompt, then add the answers you expect to check the output.
        </p>
      </section>
    )
  }

  // ── No-chooser invite ──────────────────────────────────────────────────────
  if (mode === null) {
    return (
      <section className={styles.cell} data-testid="section-eval" aria-label="Eval">
        <span className={styles.cellLabel}>Eval</span>
        <div className={styles.evalInvite} data-testid="eval-invite">
          <div className={styles.eiText}>
            <div className={styles.eiTitle}>Does the output hold up?</div>
            <div className={styles.eiSub}>
              Add the answers you expect — graded right here, on your machine, against the chart.
            </div>
          </div>
          <div className={styles.eiActions}>
            <button
              type="button"
              className={styles.btnPrimary}
              data-testid="golden-invite-add"
              onClick={() => setMode('golden')}
            >
              Add golden answers
            </button>
            <button
              type="button"
              className={styles.btnGhostLink}
              data-testid="golden-invite-judge"
              onClick={() => setMode('judge')}
            >
              or use an LLM judge
            </button>
          </div>
        </div>
      </section>
    )
  }

  // ── Judge path — N10. The LLM-judge eval layer. ─────────────────────────────
  // A criteria box + one metered verdict per patient. The judge gives a single
  // binary pass/fail (DECISION D1 — there is NO "partial" verdict state); errored
  // patients drop OUT of the denominator rather than counting as a fail.
  if (mode === 'judge') {
    return (
      <section className={styles.cell} data-testid="section-eval" aria-label="Eval">
        <div className={styles.evalHead}>
          <span className={styles.cellLabel}>Eval · LLM judge</span>
          <div className={styles.eiActions}>
            <button
              type="button"
              className={styles.btnGhostLink}
              data-testid="judge-switch-golden"
              onClick={() => setMode('golden')}
            >
              use golden answers instead
            </button>
            <button
              type="button"
              className={styles.btnPrimarySm}
              data-testid="judge-run"
              disabled={judging || !criteria.trim() || stale}
              onClick={onJudge}
            >
              {stale ? 'Re-run to score' : judging ? 'Judging…' : 'Run judge'}
            </button>
          </div>
        </div>

        {stale && (
          <p className={styles.evalStaleNote} data-testid="eval-stale-note">
            The prompt changed after this run — the outputs above are stale. Re-run to score them.
          </p>
        )}

        <p className={styles.goldenNudge} data-testid="judge-copy">
          Describe in plain language what a correct answer must contain. The judge reads each
          chart and rules per patient — one metered call each.
        </p>

        <textarea
          className={styles.criteriaIn}
          data-testid="judge-criteria"
          value={criteria}
          spellCheck={false}
          placeholder={WORKED_CRITERIA}
          onChange={(e) => setCriteria(e.target.value)}
        />

        {/* DECISION D1 (2026-06-12): partial-vs-binary verdicts resolve to a single
            binary pass/fail with honest, conservative copy. No "partial" state. */}
        <p className={styles.judgeBinary} data-testid="judge-binary-note">
          The judge returns a single <strong>pass</strong> or <strong>fail</strong> per patient —
          there is no partial credit. A partly-right answer is graded conservatively as a fail, so
          the number below is honest about what fully met your criteria.
        </p>

        <div className={stale ? styles.evalQuiet : undefined} data-stale={stale ? 'true' : 'false'}>
          <JudgeResults
            order={order}
            verdicts={verdicts}
            patientsById={patientsById}
            agree={agree}
            onToggleAgree={onToggleAgree}
            goldenScores={scores}
          />
        </div>
      </section>
    )
  }

  // ── Golden editors ──────────────────────────────────────────────────────────
  return (
    <section className={styles.cell} data-testid="section-eval" aria-label="Eval">
      <div className={styles.evalHead}>
        <span className={styles.cellLabel}>Eval · golden answers</span>
        <div className={styles.eiActions}>
          {/* Symmetric to the judge view's switch — lets a user who scored a golden
              also run a judge, so the judge-vs-golden overlap line (N17) is reachable. */}
          <button
            type="button"
            className={styles.btnGhostLink}
            data-testid="golden-switch-judge"
            onClick={() => setMode('judge')}
          >
            or use an LLM judge instead
          </button>
          <button
            type="button"
            className={styles.btnPrimarySm}
            data-testid="golden-score"
            disabled={stale}
            onClick={onScore}
          >
            {stale ? 'Re-run to score' : 'Score'}
          </button>
        </div>
      </div>

      {stale && (
        <p className={styles.evalStaleNote} data-testid="eval-stale-note">
          The prompt changed after this run — the outputs above are stale. Re-run to score them.
        </p>
      )}

      <p className={styles.goldenNudge} data-testid="golden-nudge">
        Grade the chart, not the output: write each expected answer from the patient&apos;s record,
        not by copying the model&apos;s answer above.
      </p>

      <div className={styles.goldenRows}>
        {order.map((id) => (
          <GoldenRow
            key={id}
            patientId={id}
            patient={patientsById.get(id)}
            value={golden[id] ?? ''}
            onChange={(v) => setOne(id, v)}
            grade={scores?.[id]}
            onViewChart={onViewChart}
          />
        ))}
      </div>

      <p className={styles.goldenForgive} data-testid="golden-forgive">
        The diff forgives casing, whitespace, list order, and common clinical aliases — “QD” matches
        “once daily”. A near-miss is still a miss, but you&apos;ll see exactly where.
      </p>

      {overall && (
        <div
          className={`${styles.goldenOverall} ${stale ? styles.evalQuiet : ''}`}
          data-testid="golden-overall"
          data-stale={stale ? 'true' : 'false'}
        >
          <span className={styles.ovNum}>
            {overall.passN}/{overall.total}
          </span>{' '}
          pass
          <span className={styles.ovNote}>
            {stale
              ? ' · stale — re-run to score'
              : ' · scored against your golden answers, on your machine'}
          </span>
        </div>
      )}
    </section>
  )
}
