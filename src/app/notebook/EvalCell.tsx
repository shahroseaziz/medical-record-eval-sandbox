'use client'

import { useCallback, useMemo, useState } from 'react'
import { modelDisplayName } from '@/lib/models'
import type { OutputCardResult } from './useNotebookRun'
import { useNotebookJudge, type JudgeVerdict, type JudgeCase } from './useNotebookJudge'
import type { NotebookPatient } from './types'
import { gradeGolden, type GoldenGrade } from './goldenGrade'
import { WORKED_CRITERIA } from './worked-example'
import styles from './notebook.module.css'

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
}

function JudgeResults({ order, verdicts, patientsById }: JudgeResultsProps) {
  const settled = order.map((id) => verdicts[id]).filter((v): v is JudgeVerdict => Boolean(v))
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
}

type Mode = null | 'golden' | 'judge'

export function EvalCell({ order, results, patientsById, onViewChart, byoKey }: EvalCellProps) {
  const [mode, setMode] = useState<Mode>(null)
  const [golden, setGolden] = useState<Record<string, string>>({})
  // The plain-language judge criteria the user writes (judge mode). A judge is a
  // prompt — this box IS that prompt.
  const [criteria, setCriteria] = useState('')
  const { verdicts, judging, runJudge } = useNotebookJudge()
  // The scored snapshot — null until "Score" is pressed. Holding a snapshot (vs.
  // grading live on every keystroke) keeps the verdicts stable while the user
  // edits, and makes "Score" a discrete, observable, network-free action.
  const [scores, setScores] = useState<Record<string, GoldenGrade> | null>(null)

  const hasOutput = order.some((id) => results[id]?.status === 'done')

  const setOne = useCallback((id: string, value: string) => {
    setGolden((g) => ({ ...g, [id]: value }))
  }, [])

  // CLIENT-SIDE scoring: pure functions over local state. No fetch, no metered
  // call — grading a golden never touches the network.
  const onScore = useCallback(() => {
    const next: Record<string, GoldenGrade> = {}
    for (const id of order) {
      const r = results[id]
      next[id] = gradeGolden(golden[id] ?? '', r?.output, r?.status === 'done')
    }
    setScores(next)
  }, [order, results, golden])

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
    if (!criteria.trim()) return
    const cases: JudgeCase[] = order
      .map((id) => results[id])
      .filter((r): r is OutputCardResult => Boolean(r) && r.status === 'done' && r.output.trim().length > 0)
      .map((r) => ({ patientId: r.patientId, output: r.output }))
    if (cases.length === 0) return
    void runJudge(cases, criteria, { byoKey })
  }, [criteria, order, results, runJudge, byoKey])

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
              disabled={judging || !criteria.trim()}
              onClick={onJudge}
            >
              {judging ? 'Judging…' : 'Run judge'}
            </button>
          </div>
        </div>

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

        <JudgeResults order={order} verdicts={verdicts} patientsById={patientsById} />
      </section>
    )
  }

  // ── Golden editors ──────────────────────────────────────────────────────────
  return (
    <section className={styles.cell} data-testid="section-eval" aria-label="Eval">
      <div className={styles.evalHead}>
        <span className={styles.cellLabel}>Eval · golden answers</span>
        <button
          type="button"
          className={styles.btnPrimarySm}
          data-testid="golden-score"
          onClick={onScore}
        >
          Score
        </button>
      </div>

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
        <div className={styles.goldenOverall} data-testid="golden-overall">
          <span className={styles.ovNum}>
            {overall.passN}/{overall.total}
          </span>{' '}
          pass
          <span className={styles.ovNote}>
            {' '}
            · scored against your golden answers, on your machine
          </span>
        </div>
      )}
    </section>
  )
}
