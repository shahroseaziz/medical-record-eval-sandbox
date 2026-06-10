'use client'

import { useState } from 'react'
import {
  computeUserAgreement,
  caseScore,
  caseExcluded,
  caseVerdict,
  DEFAULT_PASS_THRESHOLD,
} from '@/lib/eval/user-agreement'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'
import { Term } from './Term'
import styles from './ResultsTable.module.css'

interface Props {
  results: UserRunCaseResult[]
  initialThreshold?: number
  onThresholdChange?: (t: number) => void
  /** Present when the run was stopped before scoring all cases. */
  partial?: { scored: number; total: number; rateLimited: boolean }
  /**
   * When provided, the intent-label cell becomes interactive: the learner can
   * flip each case between designed-pass and designed-fail and watch the judge
   * agree or disagree. Omitted (the default) keeps the label read-only — the
   * worked-example and golden-set surfaces stay static.
   */
  onIntentLabelChange?: (caseId: string, label: 'pass' | 'fail') => void
}

export function DisagreementTable({
  results,
  initialThreshold = DEFAULT_PASS_THRESHOLD,
  onThresholdChange,
  partial,
  onIntentLabelChange,
}: Props) {
  const [threshold, setThreshold] = useState(initialThreshold)

  const { agreement, n, nExcluded, agreeCount } = computeUserAgreement(results, threshold)
  const { agreeCount: defaultAgreeCount } = computeUserAgreement(results, DEFAULT_PASS_THRESHOLD)

  const thresholdMoved = Math.abs(threshold - DEFAULT_PASS_THRESHOLD) > 1e-6

  function handleThresholdChange(v: number) {
    setThreshold(v)
    onThresholdChange?.(v)
  }

  return (
    <section data-testid="disagreement-table" className={styles.section}>
      <h3 className={styles.title}>Eval Run — Case Disagreement Table</h3>

      {/* What this table shows */}
      <p className={styles.intro}>
        Each row is one of your{' '}
        <Term term="golden cases" definition="Cases you captured from runs and hand-labeled as designed-pass or designed-fail. The judge scores each one; this table shows where the judge's verdict disagrees with your label." />.
        Yellow rows are disagreements — places where the judge&apos;s verdict and your{' '}
        <Term term="intent label" definition="Your declaration of what the judge ought to decide: pass (output is faithful) or fail (output contains something unfaithful or you designed it to trip the judge)." />{' '}
        don&apos;t match.
      </p>

      {/* Partial-run banner */}
      {partial && (
        <div
          data-testid="partial-run-banner"
          className={`${styles.banner} ${styles.bannerWarning}`}
        >
          {partial.rateLimited
            ? `Rate-limited — ${partial.scored} of ${partial.total} scored. Results below are partial. Click “Resume eval” to continue when the rate-limit window resets.`
            : `Partial run — ${partial.scored} of ${partial.total} scored.`}
        </div>
      )}

      {/* Calibration note */}
      <div data-testid="calibration-note" className={`${styles.banner} ${styles.bannerWarning}`}>
        A user-authored rubric is uncalibrated by construction — agreement with your own labels is
        the only available signal, and it is directional. Designed-fail cases are retained in the
        denominator.
      </div>

      {/* Threshold control */}
      <div data-testid="threshold-control" className={styles.thresholdControl}>
        <label htmlFor="threshold-slider" className={styles.thresholdLabel}>
          Pass{' '}
          <Term
            term="threshold"
            definition="The minimum faithfulness score needed to count as a PASS verdict. A score at or above this value is PASS; below is FAIL. Default is 0.85."
          />
          :
        </label>
        <input
          id="threshold-slider"
          type="range"
          data-testid="threshold-slider"
          min={0}
          max={1}
          step={0.01}
          value={threshold}
          onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
          style={{ width: 140 }}
        />
        <span data-testid="threshold-value" className={styles.thresholdValue}>
          {threshold.toFixed(2)}
        </span>
        {thresholdMoved && (
          <span data-testid="threshold-delta" className={styles.thresholdDelta}>
            at {threshold.toFixed(2)}: {agreeCount}/{n} · at {DEFAULT_PASS_THRESHOLD.toFixed(2)}:{' '}
            {defaultAgreeCount}/{n}
          </span>
        )}
      </div>

      {thresholdMoved && (
        <div
          data-testid="threshold-warning"
          className={`${styles.banner} ${styles.bannerWarning}`}
        >
          Fitting the threshold to your own labels is not validation. At this sample size (n=
          {n}) a cutoff tuned for maximum agreement just memorizes your set — it will not
          generalize. Calibrate against a held-out, human-labeled set before trusting it.
        </div>
      )}

      {/* Aggregate agreement metric */}
      <div data-testid="user-agreement-metric" className={styles.metricBox}>
        <span data-testid="agreement-value">
          <Term
            term="Agreement"
            definition="Directional: the fraction of cases where the judge's verdict matches your intent label. Not a statistical test — it tells you how well the judge is calibrated to your rubric and threshold."
          />{' '}
          (n={n}, directional):{' '}
          <strong>
            {agreement === null
              ? 'N/A'
              : `${agreeCount}/${n} (${(agreement * 100).toFixed(1)}%)`}
          </strong>
        </span>
        {nExcluded > 0 && (
          <span className={styles.excludedNote}>
            {nExcluded}{' '}
            <Term
              term="zero-claim"
              definition="The judge extracted no atomic claims from the output — this usually means the output was too short or entirely non-committal. Zero-claim cases are excluded from the agreement denominator."
            />{' '}
            case{nExcluded > 1 ? 's' : ''} excluded from denominator
          </span>
        )}
      </div>

      {/* Your judge can be wrong — three causes */}
      <details data-testid="judge-can-be-wrong-explainer" className={styles.explainer}>
        <summary className={styles.explainerSummary}>
          Your judge can be wrong — three causes of a disagreement
        </summary>
        <div className={styles.explainerBody}>
          <ol className={styles.explainerList}>
            <li className={styles.explainerItem}>
              <strong>Rubric miscalibrated.</strong> The judge&apos;s definition of{' '}
              <Term
                term="supported"
                definition="A claim verdict meaning the grounding context explicitly backs the claim. The rubric defines how strictly 'explicit' is interpreted — you can tighten or loosen it."
              />{' '}
              is stricter or looser than yours. Open the claim details and read the rationale
              — if the judge calls something &quot;unsupported&quot; but the text is clearly in
              the record, the rubric needs loosening. If it calls something &quot;supported&quot;
              when it&apos;s only implied, tighten it.
            </li>
            <li className={styles.explainerItem}>
              <strong>Threshold misplaced.</strong> The 0.85 cutoff is a starting point, not a
              law. A{' '}
              <Term
                term="faithfulness score"
                definition="The fraction of extracted claims the judge marked 'supported'. Score = supported / (supported + unsupported + partial). Ranges 0–1."
              />{' '}
              of 0.80 on a designed-pass case might just mean this query type needs a lower
              threshold. Move the slider above and watch whether agreement improves — if it
              jumps significantly at a different cutoff, the threshold was wrong for this set.
            </li>
            <li>
              <strong>The label encodes something faithfulness doesn&apos;t measure.</strong>{' '}
              Faithfulness checks whether what the model said is grounded in the context. It
              does not check whether the model said <em>enough</em>. If you designed a case to
              fail because the output was incomplete, missed a section, or was poorly formatted —
              the judge will give it a high score as long as everything stated is accurate.
              Redesign the case around a factual error, not a coverage gap.
            </li>
          </ol>
          <div className={styles.explainerFoot}>
            How to tell them apart: open the claim details, read the rationale. Rubric issues
            show up in the explanation. Threshold issues cluster near the score boundary. Scope
            issues show up in your fail reason — if it mentions completeness, style, or
            structure, faithfulness won&apos;t catch it.
          </div>
        </div>
      </details>

      {/* Per-case table */}
      <div className={styles.tableWrap}>
        <table data-testid="disagreement-case-table" className={styles.table}>
          <thead>
            <tr className={styles.headRow}>
              <th className={styles.th}>
                <Term
                  term="Intent label"
                  definition="Your declaration: designed-pass means you expect the judge to pass this output; designed-fail means you expect it to fail."
                />
              </th>
              <th className={styles.th}>Judge verdict</th>
              <th className={styles.th}>
                <Term
                  term="Score"
                  definition="Faithfulness score: supported claims ÷ total claims. At or above the threshold → PASS. Below → FAIL."
                />
              </th>
              <th className={styles.th}>
                <Term
                  term="Claims"
                  definition="Atomic factual assertions the judge extracted from the output. Each is independently checked against the grounding context."
                />
              </th>
              <th className={styles.th}>Output</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const score = caseScore(r)
              const excluded = caseExcluded(r)
              const claims = r.claims ?? []
              // Single source of truth shared with computeUserAgreement: honors a
              // field-graded row's roll-up state, falls back to score-vs-threshold
              // for legacy / pure-faithfulness rows.
              const verdictLabel = caseVerdict(r, threshold)
              const judgePass = verdictLabel === 'pass'
              const disagrees = verdictLabel !== null && verdictLabel !== r.intentLabel

              return (
                <tr
                  key={r.caseId}
                  data-testid={`disagreement-row-${r.caseId}`}
                  data-disagrees={disagrees ? 'true' : 'false'}
                  className={disagrees ? styles.rowDisagree : styles.row}
                >
                  {/* Intent label — interactive when onIntentLabelChange is provided */}
                  <td className={styles.td}>
                    {onIntentLabelChange ? (
                      <div
                        data-testid={`intent-label-control-${r.caseId}`}
                        className={styles.intentControl}
                      >
                        {(['pass', 'fail'] as const).map((label) => {
                          const active = r.intentLabel === label
                          return (
                            <button
                              key={label}
                              type="button"
                              data-testid={`set-intent-${label}-${r.caseId}`}
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

                  {/* Judge verdict */}
                  <td className={styles.td}>
                    {excluded ? (
                      <span className={styles.excluded}>excluded</span>
                    ) : (
                      <span
                        className={`${styles.badge} ${judgePass ? styles.badgePass : styles.badgeFail}`}
                      >
                        {judgePass ? 'PASS' : 'FAIL'}
                      </span>
                    )}
                  </td>

                  {/* Score */}
                  <td className={`${styles.td} ${styles.tdMono}`}>
                    {score !== null ? score.toFixed(2) : 'N/A'}
                  </td>

                  {/* Claims */}
                  <td className={styles.td}>
                    {claims.length === 0 ? (
                      <span className={styles.naCell}>—</span>
                    ) : (
                      <details>
                        <summary className={styles.claimSummary}>
                          {claims.length} claim{claims.length > 1 ? 's' : ''}
                        </summary>
                        <ul className={styles.claimList}>
                          {claims.map((c, i) => (
                            <li key={i} className={styles.claimItem}>
                              <span
                                className={`${styles.claimVerdict} ${claimVerdictClass(c.verdict)}`}
                              >
                                [{c.verdict}]
                              </span>{' '}
                              <span>{c.claim}</span>
                              {c.rationale && (
                                <div className={styles.claimRationale}>{c.rationale}</div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>

                  {/* Output */}
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

function claimVerdictClass(verdict: 'supported' | 'unsupported' | 'partial'): string {
  return verdict === 'supported'
    ? styles.claimSupported
    : verdict === 'unsupported'
      ? styles.claimUnsupported
      : styles.claimPartial
}
