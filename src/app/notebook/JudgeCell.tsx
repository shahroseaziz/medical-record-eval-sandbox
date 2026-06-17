'use client'

import { useCallback, useEffect, useState } from 'react'
import type { PerCaseScore } from '@/lib/notebook/state'
import type { OutputCardResult } from './useNotebookRun'
import { useNotebookJudge, type JudgeVerdict, type JudgeCase } from './useNotebookJudge'
import type { NotebookPatient } from './types'
import type { AgreeMark } from './judgeAgreement'
import { JudgeResults, type ScoreReport } from './EvalCell'
import { WORKED_CRITERIA } from './worked-example'
import { judgeCostLine, countJudgeable } from './judgeCost'
import styles from './notebook.module.css'

/**
 * Added-judge cell (SHA-167 N14) — a judge the user spun up with "+ Add another
 * eval". It is a self-contained eval cell: its own criteria box, its own
 * `useNotebookJudge` loop, its own per-patient verdicts, and a REMOVE control.
 *
 * Each added judge owns a distinct cube eval key (`judge:<id>`); the golden set
 * stays SINGULAR (only judges multiply). Removing the cell lifts a remove up so
 * the shell can clean this judge's scores out of the cube — a deleted judge
 * leaves no trace in state or in an export.
 *
 * The verdict rendering, the binary-only copy, and the do-you-agree thumbs are
 * shared with the primary eval via the exported `JudgeResults` — this cell is the
 * SAME judge UI, just numbered and removable.
 */

export interface JudgeCellProps {
  /** The cube eval key for this judge — `judge:<id>`. */
  evalKey: string
  /** The user-facing label, e.g. "LLM judge 2". */
  label: string
  /** Patient ids in the order the current run submitted them. */
  order: string[]
  results: Record<string, OutputCardResult>
  patientsById: Map<string, NotebookPatient>
  /** BYO Anthropic key, forwarded to the judge call in-flight only (never logged). */
  byoKey?: string
  /** A stored BYO key — flips the cost-preview copy (billed-to-key vs. metered). */
  hasKey: boolean
  /** Lift a scored judge row up to the cube owner (the shell), keyed by `evalKey`. */
  onScoreReport?: (report: ScoreReport) => void
  /** Remove this judge cell — the shell drops it AND cleans its cube scores. */
  onRemove: () => void
}

export function JudgeCell({
  evalKey,
  label,
  order,
  results,
  patientsById,
  byoKey,
  hasKey,
  onScoreReport,
  onRemove,
}: JudgeCellProps) {
  const [criteria, setCriteria] = useState('')
  const [agree, setAgree] = useState<Record<string, AgreeMark>>({})
  const { verdicts, judging, runJudge, judgeRunId } = useNotebookJudge()

  // ── One metered call per patient with gradeable output (mirrors EvalCell) ────
  const onJudge = useCallback(() => {
    if (!criteria.trim()) return
    const cases: JudgeCase[] = order
      .map((id) => results[id])
      .filter(
        (r): r is OutputCardResult =>
          Boolean(r) && r.status === 'done' && r.output.trim().length > 0,
      )
      .map((r) => ({ patientId: r.patientId, output: r.output }))
    if (cases.length === 0) return
    void runJudge(cases, criteria, { byoKey })
  }, [criteria, order, results, runJudge, byoKey])

  // A fresh judge run produces fresh verdicts, so prior agree marks no longer apply.
  useEffect(() => {
    setAgree({})
  }, [judgeRunId])

  const onToggleAgree = useCallback((patientId: string, mark: AgreeMark) => {
    setAgree((prev) => {
      const next = { ...prev }
      if (next[patientId] === mark) delete next[patientId]
      else next[patientId] = mark
      return next
    })
  }, [])

  // Lift this judge's row into the cube under its OWN eval key once verdicts settle.
  // Errored patients are excluded from the denominator, mirroring the primary judge.
  useEffect(() => {
    if (!onScoreReport || judging) return
    const settled = order
      .map((id) => verdicts[id])
      .filter(
        (v): v is JudgeVerdict =>
          Boolean(v) && (v.status === 'done' || v.status === 'errored'),
      )
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
      evalKey,
      label,
      criteriaOrGolden: criteria,
      row: { frac: `${passN}/${scored.length}`, per },
    })
  }, [verdicts, judging, order, criteria, evalKey, label, onScoreReport])

  const judgeable = countJudgeable(order, results)

  return (
    <section
      className={styles.cell}
      data-testid="judge-cell"
      data-eval-key={evalKey}
      aria-label={label}
    >
      <div className={styles.evalHead}>
        <span className={styles.cellLabel}>Eval · {label}</span>
        <div className={styles.eiActions}>
          <button
            type="button"
            className={styles.btnGhostLink}
            data-testid="judge-cell-remove"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            Remove
          </button>
          <button
            type="button"
            className={styles.btnPrimarySm}
            data-testid="judge-cell-run"
            disabled={judging || !criteria.trim()}
            onClick={onJudge}
          >
            {judging ? 'Judging…' : 'Run judge'}
          </button>
        </div>
      </div>

      <p className={styles.goldenNudge} data-testid="judge-cell-copy">
        Describe in plain language what a correct answer must contain. This judge reads each chart
        and rules per patient — one metered call each.
      </p>

      <textarea
        className={styles.criteriaIn}
        data-testid="judge-cell-criteria"
        value={criteria}
        spellCheck={false}
        placeholder={WORKED_CRITERIA}
        onChange={(e) => setCriteria(e.target.value)}
      />

      <div className={styles.runNote} data-testid="judge-cell-cost">
        {judgeCostLine(1, judgeable, hasKey)}
      </div>

      <JudgeResults
        order={order}
        verdicts={verdicts}
        patientsById={patientsById}
        agree={agree}
        onToggleAgree={onToggleAgree}
        goldenScores={null}
      />
    </section>
  )
}
