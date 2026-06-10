'use client'

import {
  computeUserAgreement,
  caseScore,
  caseExcluded,
  caseVerdict,
  DEFAULT_PASS_THRESHOLD,
} from '@/lib/eval/user-agreement'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'
import type { BenchCase, EvaluatorType, StructuredDiffDetail } from '@/lib/workbench/bench'
import type { StructuredFieldDiff } from '@/lib/eval/types'
import { Term } from './Term'
import styles from './ResultsTable.module.css'

interface Props {
  evaluator: Exclude<EvaluatorType, 'faithfulness'>
  cases: BenchCase[]
  results: UserRunCaseResult[]
  /** Per-case structured-diff detail; only consulted for the structured-diff evaluator. */
  diffDetails?: StructuredDiffDetail[]
  /** Flip a case's designed pass/fail label and watch agreement move. */
  onIntentLabelChange?: (caseId: string, label: 'pass' | 'fail') => void
}

/**
 * Results surface for the two answer-key evaluators (reference judge, structured
 * diff). Unlike the faithfulness surface (DisagreementTable — grounding + claims,
 * NO expected column), this surface has an EXPECTED column: the hand-authored
 * answer key the verdict is measured against. Switching the evaluator from one of
 * these to faithfulness is what "reshapes the surface" — the expected column
 * disappears because faithfulness needs no answer key (rule 14).
 *
 * Verdicts here are frozen per-field roll-up `state` (each field was classified at
 * scoring time against its own scorer's config threshold), so there is no global
 * threshold slider — that control is faithfulness-only.
 */
export function EvaluatorResultsTable({
  evaluator,
  cases,
  results,
  diffDetails,
  onIntentLabelChange,
}: Props) {
  const { agreement, n, nExcluded, agreeCount } = computeUserAgreement(
    results,
    DEFAULT_PASS_THRESHOLD,
  )
  const caseById = new Map(cases.map((c) => [c.caseId, c]))
  const diffById = new Map((diffDetails ?? []).map((d) => [d.caseId, d]))
  const expectedHeader = evaluator === 'reference-judge' ? 'Expected prose' : 'Expected list'

  return (
    <section data-testid="evaluator-results-table" data-evaluator={evaluator} className={styles.section}>
      <h3 className={styles.title}>
        Eval Run — {evaluator === 'reference-judge' ? 'Reference judge' : 'Structured diff'} vs
        answer key
      </h3>

      <p className={styles.intro}>
        This evaluator grades against a hand-authored{' '}
        <Term
          term="answer key"
          definition="The expected output you authored for each case. The reference judge compares meaning against expected prose; the structured diff aligns an expected list field-by-field. Faithfulness needs no answer key — switch to it and this column disappears."
        />
        . The <strong>Expected</strong> column is the key; faithfulness has none.
      </p>

      {/* Aggregate agreement */}
      <div data-testid="evaluator-agreement-metric" className={styles.metricBox}>
        <span data-testid="evaluator-agreement-value">
          <Term
            term="Agreement"
            definition="Directional: the fraction of cases where the evaluator's verdict matches your intent label. Not a statistical test — it tells you how well the evaluator tracks your labels."
          />{' '}
          (n={n}, directional):{' '}
          <strong>
            {agreement === null ? 'N/A' : `${agreeCount}/${n} (${(agreement * 100).toFixed(1)}%)`}
          </strong>
        </span>
        {nExcluded > 0 && (
          <span className={styles.excludedNote}>
            {nExcluded} case{nExcluded > 1 ? 's' : ''} excluded (no answer key for this evaluator)
          </span>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table data-testid="evaluator-case-table" className={styles.table}>
          <thead>
            <tr className={styles.headRow}>
              <th className={styles.th}>Intent label</th>
              <th className={styles.th}>Verdict</th>
              <th className={styles.th}>Score</th>
              <th className={styles.th} data-testid="expected-column-header">
                {expectedHeader}
              </th>
              <th className={styles.th}>Output</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const bc = caseById.get(r.caseId)
              const score = caseScore(r)
              const excluded = caseExcluded(r)
              const verdict = caseVerdict(r, DEFAULT_PASS_THRESHOLD)
              const pass = verdict === 'pass'
              const disagrees = verdict !== null && verdict !== r.intentLabel
              return (
                <tr
                  key={r.caseId}
                  data-testid={`evaluator-row-${r.caseId}`}
                  data-disagrees={disagrees ? 'true' : 'false'}
                  className={disagrees ? styles.rowDisagree : styles.row}
                >
                  <td className={styles.td}>
                    {onIntentLabelChange ? (
                      <div
                        data-testid={`evaluator-intent-control-${r.caseId}`}
                        className={styles.intentControl}
                      >
                        {(['pass', 'fail'] as const).map((label) => {
                          const active = r.intentLabel === label
                          return (
                            <button
                              key={label}
                              type="button"
                              data-testid={`evaluator-set-intent-${label}-${r.caseId}`}
                              aria-pressed={active}
                              onClick={() => onIntentLabelChange(r.caseId, label)}
                              className={`${styles.badge} ${
                                label === 'pass' ? styles.badgePass : styles.badgeFail
                              } ${styles.intentBtn} ${
                                active ? styles.intentBtnActive : styles.intentBtnInactive
                              }`}
                            >
                              {label === 'pass' ? 'designed-pass' : 'designed-fail'}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <span
                        className={`${styles.badge} ${
                          r.intentLabel === 'pass' ? styles.badgePass : styles.badgeFail
                        }`}
                      >
                        {r.intentLabel === 'pass' ? 'designed-pass' : 'designed-fail'}
                      </span>
                    )}
                  </td>

                  <td className={styles.td}>
                    {excluded ? (
                      <span className={styles.excluded}>excluded</span>
                    ) : (
                      <span className={`${styles.badge} ${pass ? styles.badgePass : styles.badgeFail}`}>
                        {pass ? 'PASS' : 'FAIL'}
                      </span>
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.tdMono}`}>
                    {score !== null ? score.toFixed(2) : 'N/A'}
                  </td>

                  {/* Expected — the answer key this evaluator measures against */}
                  <td className={`${styles.td} ${styles.expectedCell}`} data-testid={`expected-${r.caseId}`}>
                    {evaluator === 'reference-judge' ? (
                      <span>{bc?.expectedProse || '—'}</span>
                    ) : (
                      <StructuredExpected detail={diffById.get(r.caseId)} bc={bc} />
                    )}
                  </td>

                  <td className={`${styles.td} ${styles.outputCell}`} title={r.output}>
                    {r.output.slice(0, 80)}
                    {r.output.length > 80 ? '…' : ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function StructuredExpected({
  detail,
  bc,
}: {
  detail?: StructuredDiffDetail
  bc?: BenchCase
}) {
  if (!bc?.expectedStructured) {
    return <span className={styles.naCell}>not applicable (no structured key)</span>
  }
  const meds = bc.expectedStructured.medications
  return (
    <details>
      <summary className={styles.claimSummary}>
        {meds.length} expected item{meds.length > 1 ? 's' : ''}
      </summary>
      <ul className={styles.expectedList}>
        {meds.map((m, i) => (
          <li key={i}>
            {m.name}
            {m.dose ? ` ${m.dose}` : ''}
          </li>
        ))}
      </ul>
      {detail && detail.fields.length > 0 && (
        <div className={styles.fieldChips}>
          {detail.fields.map((f, i) => (
            <FieldDiffBadge key={i} f={f} />
          ))}
        </div>
      )}
    </details>
  )
}

function FieldDiffBadge({ f }: { f: StructuredFieldDiff }) {
  const toneClass =
    f.status === 'match'
      ? styles.fieldChipMatch
      : f.status === 'mismatch'
        ? styles.fieldChipMismatch
        : styles.fieldChipPartial
  return (
    <span className={`${styles.fieldChip} ${toneClass}`}>
      {f.item}.{f.field}: {f.status}
    </span>
  )
}
