'use client'

import {
  computeLabelAgreement,
  caseVerdict,
  caseExcluded,
  DEFAULT_PASS_THRESHOLD,
} from '@/lib/eval/user-agreement'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'
import { Term } from './Term'
import styles from './ResultsTable.module.css'

interface Props {
  /** The scored outputs of the current run (scorer-agnostic). */
  results: UserRunCaseResult[]
  /** The user's pass/fail labels, keyed by case id — `BenchSet.labels` (E26). */
  labels: Record<string, 'pass' | 'fail'>
  /** The active evaluator's pass threshold (config-read, never hardcoded — rule 15). */
  threshold?: number
  /** Mark a user label on a scored output (persisted to `BenchSet.labels`). */
  onLabel: (caseId: string, label: 'pass' | 'fail') => void
  /** Clear a user label (toggle off). */
  onClearLabel?: (caseId: string) => void
}

/**
 * The G5 "judge agrees with the clinician" surface (E26). The user marks their own
 * pass/fail labels on scored outputs — a DISTINCT artifact from the case's designed
 * intent label — and the agreement metric reports how often the judge's verdict
 * matches the clinician's. This is validate-the-validator made tangible: author a
 * bad rubric, watch agreement drop.
 *
 * The metric is unpopulated until ≥1 output is labeled (never a vacuous 100%), the
 * disagreeing cases are one click away, and the clinician-seat framing carries at
 * both the authoring moment (you define correct) and the disagreement moment (the
 * judge inherits your blind spots). The self-preference caveat ships because the
 * bench's Haiku judge grades Haiku-generated output (a documented LLM-judge bias).
 */
export function ClinicianAgreement({
  results,
  labels,
  threshold = DEFAULT_PASS_THRESHOLD,
  onLabel,
  onClearLabel,
}: Props) {
  const { populated, agreement, n, nExcluded, agreeCount, disagreers } = computeLabelAgreement(
    results,
    labels,
    threshold,
  )
  const disagreeSet = new Set(disagreers)
  const labeledCount = results.filter((r) => labels[r.caseId] !== undefined).length

  return (
    <section data-testid="clinician-agreement" className={styles.section}>
      <h3 className={styles.title}>The clinician seat — does the judge agree with you?</h3>

      {/* Clinician-seat copy at the AUTHORING moment (G5). */}
      <p className={styles.intro} data-testid="clinician-authoring-copy">
        You define what &quot;correct&quot; means here. Your pass/fail labels are the ground truth
        the judge is validated against — in healthcare the deployment question is never &quot;is the
        judge right&quot; but{' '}
        <strong>&quot;does the judge agree with the clinician.&quot;</strong> Label the outputs
        below and the agreement rate fills in.
      </p>

      {/* Aggregate metric — unpopulated until ≥1 label (never a vacuous 100%). */}
      {populated ? (
        <div data-testid="clinician-agreement-metric" className={styles.metricBox}>
          <span data-testid="clinician-agreement-value">
            Your judge agrees with your labels on{' '}
            <strong>
              {agreement === null ? 'N/A' : `${agreeCount} of ${n} case${n === 1 ? '' : 's'}`}
            </strong>{' '}
            <Term
              term={`(n=${n}, directional)`}
              definition="Directional, not a statistical test: the fraction of your labeled, scoreable cases where the judge's verdict matches your label. Your labels are uncalibrated by construction, so agreement with your own labels is the only available signal — and it's directional."
            />
            {agreement !== null && ` — ${(agreement * 100).toFixed(0)}%`}
          </span>
          {nExcluded > 0 && (
            <span className={styles.excludedNote} data-testid="clinician-agreement-excluded">
              {nExcluded}{' '}
              <Term
                term="zero-claim"
                definition="A labeled output the judge could not score (no atomic claims, or nothing scoreable). Excluded from the agreement denominator — never counted as a vacuous agreement."
              />{' '}
              labeled case{nExcluded > 1 ? 's' : ''} excluded from the denominator
            </span>
          )}
        </div>
      ) : (
        <div data-testid="clinician-agreement-empty" className={`${styles.banner}`}>
          No labels yet — <strong>label at least one output below</strong> to populate the
          agreement rate. It stays blank until you do (an empty label set is not 100% agreement).
        </div>
      )}

      {/* Disagreeing cases — one click away (G5). */}
      {populated && disagreers.length > 0 && (
        <details data-testid="clinician-disagreers" className={styles.explainer}>
          <summary className={styles.explainerSummary}>
            {disagreers.length} case{disagreers.length > 1 ? 's' : ''} where the judge disagrees with
            you — open them
          </summary>
          <div className={styles.explainerBody}>
            {/* Clinician-seat copy at the DISAGREEMENT moment (G5). */}
            <p data-testid="clinician-disagreement-copy">
              Read each output yourself. Either the judge is miscalibrated against your rubric, or
              the judge inherited a blind spot in how you labeled — <strong>both are findings.</strong>{' '}
              This is the only place an uncalibrated rubric teaches its own lesson.
            </p>
            <ul className={styles.explainerList}>
              {results
                .filter((r) => disagreeSet.has(r.caseId))
                .map((r) => (
                  <li
                    key={r.caseId}
                    data-testid={`clinician-disagreer-${r.caseId}`}
                    className={styles.explainerItem}
                  >
                    <strong>{r.taskPrompt.slice(0, 60)}</strong> — you labeled{' '}
                    {labels[r.caseId] === 'pass' ? 'designed-pass' : 'designed-fail'}, judge said{' '}
                    {caseVerdict(r, threshold) === 'pass' ? 'PASS' : 'FAIL'}.
                  </li>
                ))}
            </ul>
          </div>
        </details>
      )}

      {/* Per-output label affordance — mark each scored output pass/fail. */}
      <ul className={styles.explainerList} data-testid="clinician-label-list" style={{ listStyle: 'none', padding: 0 }}>
        {results.map((r) => {
          const excluded = caseExcluded(r)
          const verdict = caseVerdict(r, threshold)
          const userLabel = labels[r.caseId]
          const disagrees = disagreeSet.has(r.caseId)
          return (
            <li
              key={r.caseId}
              data-testid={`clinician-row-${r.caseId}`}
              data-disagrees={disagrees ? 'true' : 'false'}
              className={disagrees ? styles.rowDisagree : styles.row}
              style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', padding: '0.35rem 0' }}
            >
              <span style={{ flex: 1, fontSize: '0.82rem' }}>
                {r.taskPrompt.slice(0, 56)}
                {r.taskPrompt.length > 56 ? '…' : ''}
              </span>
              <span style={{ fontSize: '0.78rem', color: '#666', minWidth: 64 }}>
                judge:{' '}
                {excluded ? 'excluded' : verdict === 'pass' ? 'PASS' : verdict === 'fail' ? 'FAIL' : 'N/A'}
              </span>
              <div
                data-testid={`clinician-label-control-${r.caseId}`}
                className={styles.intentControl}
              >
                {(['pass', 'fail'] as const).map((label) => {
                  const active = userLabel === label
                  return (
                    <button
                      key={label}
                      type="button"
                      data-testid={`clinician-set-${label}-${r.caseId}`}
                      aria-pressed={active}
                      onClick={() =>
                        active && onClearLabel ? onClearLabel(r.caseId) : onLabel(r.caseId, label)
                      }
                      className={`${styles.badge} ${
                        label === 'pass' ? styles.badgePass : styles.badgeFail
                      } ${styles.intentBtn} ${active ? styles.intentBtnActive : styles.intentBtnInactive}`}
                    >
                      {label === 'pass' ? 'pass' : 'fail'}
                    </button>
                  )
                })}
              </div>
            </li>
          )
        })}
      </ul>

      <p style={{ fontSize: '0.78rem', color: '#888', marginTop: '0.5rem' }}>
        {labeledCount} of {results.length} output{results.length === 1 ? '' : 's'} labeled. Labels
        persist with this set, independently of any run — a baseline-vs-current swap never discards
        them.
      </p>

      {/* Self-preference disclosure (E26) — Haiku judging Haiku-generated output. */}
      <div
        data-testid="clinician-self-preference"
        className={`${styles.banner} ${styles.bannerWarning}`}
      >
        <strong>Self-preference:</strong> this bench&apos;s outputs are generated by Haiku and graded
        by a Haiku judge. A model judging its own family is a documented LLM-judge bias — the
        fixed-judge design is deliberate, but the caveat is named here so the agreement rate is read
        with it in mind.
      </div>
    </section>
  )
}
