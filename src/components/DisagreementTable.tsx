'use client'

import { useState } from 'react'
import { computeUserAgreement, DEFAULT_PASS_THRESHOLD } from '@/lib/eval/user-agreement'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'

interface Props {
  results: UserRunCaseResult[]
  initialThreshold?: number
  onThresholdChange?: (t: number) => void
}

export function DisagreementTable({
  results,
  initialThreshold = DEFAULT_PASS_THRESHOLD,
  onThresholdChange,
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
          Pass threshold:
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
          Agreement (n={n}, directional):{' '}
          <strong>
            {agreement === null
              ? 'N/A'
              : `${agreeCount}/${n} (${(agreement * 100).toFixed(1)}%)`}
          </strong>
        </span>
        {nExcluded > 0 && (
          <span style={{ color: '#888', fontSize: '0.80rem' }}>
            {nExcluded} zero-claim case{nExcluded > 1 ? 's' : ''} excluded from denominator
          </span>
        )}
      </div>

      {/* Per-case table */}
      <div style={{ overflowX: 'auto' }}>
        <table
          data-testid="disagreement-case-table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}
        >
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={TH}>Intent label</th>
              <th style={TH}>Judge verdict</th>
              <th style={TH}>Score</th>
              <th style={TH}>Claims</th>
              <th style={TH}>Output</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const judgePass =
                !r.zeroClaimFlag && r.faithfulnessScore !== null && r.faithfulnessScore >= threshold
              const verdictLabel = r.zeroClaimFlag ? null : judgePass ? 'pass' : 'fail'
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
                    {r.zeroClaimFlag ? (
                      <span style={{ color: '#888', fontSize: '0.75rem' }}>zero-claim</span>
                    ) : (
                      <span style={verdictBadge(judgePass)}>{judgePass ? 'PASS' : 'FAIL'}</span>
                    )}
                  </td>

                  {/* Score */}
                  <td style={{ ...TD, fontFamily: 'monospace' }}>
                    {r.faithfulnessScore !== null ? r.faithfulnessScore.toFixed(2) : 'N/A'}
                  </td>

                  {/* Claims */}
                  <td style={TD}>
                    {r.claims.length === 0 ? (
                      <span style={{ color: '#aaa' }}>—</span>
                    ) : (
                      <details>
                        <summary style={{ cursor: 'pointer' }}>
                          {r.claims.length} claim{r.claims.length > 1 ? 's' : ''}
                        </summary>
                        <ul
                          style={{ margin: '4px 0', padding: '0 0 0 10px', listStyle: 'none' }}
                        >
                          {r.claims.map((c, i) => (
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
