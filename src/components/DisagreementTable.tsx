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

interface Props {
  results: UserRunCaseResult[]
  initialThreshold?: number
  onThresholdChange?: (t: number) => void
  /** Present when the run was stopped before scoring all cases. */
  partial?: { scored: number; total: number; rateLimited: boolean }
}

export function DisagreementTable({
  results,
  initialThreshold = DEFAULT_PASS_THRESHOLD,
  onThresholdChange,
  partial,
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
    <section data-testid="disagreement-table" style={{ fontSize: '0.9rem', marginTop: '1rem' }}>
      <h3 style={{ fontSize: '0.95rem', marginTop: 0, marginBottom: '0.5rem' }}>
        Eval Run — Case Disagreement Table
      </h3>

      {/* What this table shows */}
      <p style={{ fontSize: '0.8rem', color: '#555', margin: '0 0 0.5rem' }}>
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
          style={{
            padding: '0.4rem 0.6rem',
            background: '#fff3cd',
            border: '1px solid #e8a000',
            borderRadius: 4,
            fontSize: '0.8rem',
            color: '#5c3c00',
            marginBottom: '0.5rem',
          }}
        >
          {partial.rateLimited
            ? `Rate-limited — ${partial.scored} of ${partial.total} scored. Results below are partial. Click “Resume eval” to continue when the rate-limit window resets.`
            : `Partial run — ${partial.scored} of ${partial.total} scored.`}
        </div>
      )}

      {/* Calibration note */}
      <div
        data-testid="calibration-note"
        style={{
          padding: '0.4rem 0.6rem',
          background: '#fff8ec',
          border: '1px solid #e8c060',
          borderRadius: 4,
          fontSize: '0.8rem',
          color: '#665000',
          marginBottom: '0.75rem',
        }}
      >
        A user-authored rubric is uncalibrated by construction — agreement with your own labels is
        the only available signal, and it is directional. Designed-fail cases are retained in the
        denominator.
      </div>

      {/* Threshold control */}
      <div
        data-testid="threshold-control"
        style={{
          marginBottom: '0.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          fontSize: '0.85rem',
        }}
      >
        <label htmlFor="threshold-slider" style={{ fontWeight: 600 }}>
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
        <span data-testid="threshold-value" style={{ fontFamily: 'monospace' }}>
          {threshold.toFixed(2)}
        </span>
        {thresholdMoved && (
          <span data-testid="threshold-delta" style={{ color: '#555' }}>
            at {threshold.toFixed(2)}: {agreeCount}/{n} · at {DEFAULT_PASS_THRESHOLD.toFixed(2)}:{' '}
            {defaultAgreeCount}/{n}
          </span>
        )}
      </div>

      {thresholdMoved && (
        <div
          data-testid="threshold-warning"
          style={{
            padding: '0.4rem 0.6rem',
            background: '#fffbe6',
            border: '1px solid #f5c542',
            borderRadius: 4,
            fontSize: '0.8rem',
            color: '#7a5a00',
            marginBottom: '0.5rem',
          }}
        >
          Fitting the threshold to your own labels is not validation.
        </div>
      )}

      {/* Aggregate agreement metric */}
      <div
        data-testid="user-agreement-metric"
        style={{
          display: 'flex',
          gap: '1rem',
          flexWrap: 'wrap',
          padding: '0.5rem 0.75rem',
          background: '#f7f7f7',
          border: '1px solid #ddd',
          borderRadius: 6,
          marginBottom: '0.75rem',
          fontSize: '0.85rem',
          alignItems: 'center',
        }}
      >
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
          <span style={{ color: '#888', fontSize: '0.80rem' }}>
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
      <details
        data-testid="judge-can-be-wrong-explainer"
        style={{ marginBottom: '0.75rem', fontSize: '0.82rem' }}
      >
        <summary
          style={{ cursor: 'pointer', fontWeight: 600, color: '#444', padding: '0.2rem 0' }}
        >
          Your judge can be wrong — three causes of a disagreement
        </summary>
        <div
          style={{
            marginTop: '0.4rem',
            padding: '0.6rem 0.8rem',
            background: '#f9f7ff',
            border: '1px solid #d4c4f0',
            borderRadius: 4,
            lineHeight: 1.6,
          }}
        >
          <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
            <li style={{ marginBottom: '0.5rem' }}>
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
            <li style={{ marginBottom: '0.5rem' }}>
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
          <div
            style={{
              marginTop: '0.5rem',
              paddingTop: '0.5rem',
              borderTop: '1px solid #e0d8f8',
              color: '#555',
              fontSize: '0.8rem',
            }}
          >
            How to tell them apart: open the claim details, read the rationale. Rubric issues
            show up in the explanation. Threshold issues cluster near the score boundary. Scope
            issues show up in your fail reason — if it mentions completeness, style, or
            structure, faithfulness won&apos;t catch it.
          </div>
        </div>
      </details>

      {/* Per-case table */}
      <div style={{ overflowX: 'auto' }}>
        <table
          data-testid="disagreement-case-table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}
        >
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={TH}>
                <Term
                  term="Intent label"
                  definition="Your declaration: designed-pass means you expect the judge to pass this output; designed-fail means you expect it to fail."
                />
              </th>
              <th style={TH}>Judge verdict</th>
              <th style={TH}>
                <Term
                  term="Score"
                  definition="Faithfulness score: supported claims ÷ total claims. At or above the threshold → PASS. Below → FAIL."
                />
              </th>
              <th style={TH}>
                <Term
                  term="Claims"
                  definition="Atomic factual assertions the judge extracted from the output. Each is independently checked against the grounding context."
                />
              </th>
              <th style={TH}>Output</th>
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
                  style={{
                    background: disagrees ? '#fff3cd' : undefined,
                    borderLeft: `3px solid ${disagrees ? '#e8a000' : 'transparent'}`,
                  }}
                >
                  {/* Intent label */}
                  <td style={TD}>
                    <span style={intentBadge(r.intentLabel)}>
                      {r.intentLabel === 'pass' ? 'designed-pass' : 'designed-fail'}
                    </span>
                  </td>

                  {/* Judge verdict */}
                  <td style={TD}>
                    {excluded ? (
                      <span style={{ color: '#888', fontSize: '0.75rem' }}>excluded</span>
                    ) : (
                      <span style={verdictBadge(judgePass)}>{judgePass ? 'PASS' : 'FAIL'}</span>
                    )}
                  </td>

                  {/* Score */}
                  <td style={{ ...TD, fontFamily: 'monospace' }}>
                    {score !== null ? score.toFixed(2) : 'N/A'}
                  </td>

                  {/* Claims */}
                  <td style={TD}>
                    {claims.length === 0 ? (
                      <span style={{ color: '#aaa' }}>—</span>
                    ) : (
                      <details>
                        <summary style={{ cursor: 'pointer' }}>
                          {claims.length} claim{claims.length > 1 ? 's' : ''}
                        </summary>
                        <ul
                          style={{ margin: '4px 0', padding: '0 0 0 10px', listStyle: 'none' }}
                        >
                          {claims.map((c, i) => (
                            <li key={i} style={{ marginBottom: 3 }}>
                              <span style={claimVerdictColor(c.verdict)}>[{c.verdict}]</span>{' '}
                              <span>{c.claim}</span>
                              {c.rationale && (
                                <div
                                  style={{
                                    color: '#666',
                                    fontSize: '0.72rem',
                                    marginLeft: 8,
                                    marginTop: 1,
                                  }}
                                >
                                  {c.rationale}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>

                  {/* Output */}
                  <td
                    style={{
                      ...TD,
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.output}
                  >
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

// ── Style helpers ─────────────────────────────────────────────────────────────

const TH: React.CSSProperties = {
  padding: '4px 8px',
  textAlign: 'left',
  border: '1px solid #ddd',
  fontWeight: 600,
}

const TD: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #eee',
  verticalAlign: 'top',
}

function intentBadge(label: 'pass' | 'fail'): React.CSSProperties {
  return {
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: '0.75rem',
    fontWeight: 600,
    background: label === 'pass' ? '#e6f9ee' : '#fde8e8',
    border: `1px solid ${label === 'pass' ? '#2a7' : '#c00'}`,
    color: label === 'pass' ? '#1a5' : '#c00',
    display: 'inline-block',
  }
}

function verdictBadge(pass: boolean): React.CSSProperties {
  return {
    padding: '1px 6px',
    borderRadius: 3,
    fontSize: '0.75rem',
    fontWeight: 600,
    background: pass ? '#e6f9ee' : '#fde8e8',
    border: `1px solid ${pass ? '#2a7' : '#c00'}`,
    color: pass ? '#1a5' : '#c00',
    display: 'inline-block',
  }
}

function claimVerdictColor(verdict: 'supported' | 'unsupported' | 'partial'): React.CSSProperties {
  return {
    color: verdict === 'supported' ? '#2a7' : verdict === 'unsupported' ? '#c00' : '#a80',
    fontWeight: 600,
    fontSize: '0.72rem',
  }
}
