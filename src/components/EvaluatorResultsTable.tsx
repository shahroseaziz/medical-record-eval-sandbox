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
    <section
      data-testid="evaluator-results-table"
      data-evaluator={evaluator}
      style={{ fontSize: '0.9rem' }}
    >
      <h3 style={{ fontSize: '0.95rem', marginTop: 0, marginBottom: '0.5rem' }}>
        Eval Run — {evaluator === 'reference-judge' ? 'Reference judge' : 'Structured diff'} vs
        answer key
      </h3>

      <p style={{ fontSize: '0.8rem', color: '#555', margin: '0 0 0.5rem' }}>
        This evaluator grades against a hand-authored{' '}
        <Term
          term="answer key"
          definition="The expected output you authored for each case. The reference judge compares meaning against expected prose; the structured diff aligns an expected list field-by-field. Faithfulness needs no answer key — switch to it and this column disappears."
        />
        . The <strong>Expected</strong> column is the key; faithfulness has none.
      </p>

      {/* Aggregate agreement */}
      <div
        data-testid="evaluator-agreement-metric"
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
          <span style={{ color: '#888', fontSize: '0.8rem' }}>
            {nExcluded} case{nExcluded > 1 ? 's' : ''} excluded (no answer key for this evaluator)
          </span>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table
          data-testid="evaluator-case-table"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}
        >
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={TH}>Intent label</th>
              <th style={TH}>Verdict</th>
              <th style={TH}>Score</th>
              <th style={TH} data-testid="expected-column-header">
                {expectedHeader}
              </th>
              <th style={TH}>Output</th>
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
                  style={{
                    background: disagrees ? '#fff3cd' : undefined,
                    borderLeft: `3px solid ${disagrees ? '#e8a000' : 'transparent'}`,
                  }}
                >
                  <td style={TD}>
                    {onIntentLabelChange ? (
                      <div
                        data-testid={`evaluator-intent-control-${r.caseId}`}
                        style={{ display: 'flex', gap: 4 }}
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
                              style={{
                                ...intentBadge(label),
                                cursor: 'pointer',
                                opacity: active ? 1 : 0.4,
                                borderWidth: active ? 2 : 1,
                              }}
                            >
                              {label === 'pass' ? 'designed-pass' : 'designed-fail'}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <span style={intentBadge(r.intentLabel)}>
                        {r.intentLabel === 'pass' ? 'designed-pass' : 'designed-fail'}
                      </span>
                    )}
                  </td>

                  <td style={TD}>
                    {excluded ? (
                      <span style={{ color: '#888', fontSize: '0.75rem' }}>excluded</span>
                    ) : (
                      <span style={verdictBadge(pass)}>{pass ? 'PASS' : 'FAIL'}</span>
                    )}
                  </td>

                  <td style={{ ...TD, fontFamily: 'monospace' }}>
                    {score !== null ? score.toFixed(2) : 'N/A'}
                  </td>

                  {/* Expected — the answer key this evaluator measures against */}
                  <td style={{ ...TD, maxWidth: 260 }} data-testid={`expected-${r.caseId}`}>
                    {evaluator === 'reference-judge' ? (
                      <span style={{ color: '#333' }}>{bc?.expectedProse || '—'}</span>
                    ) : (
                      <StructuredExpected detail={diffById.get(r.caseId)} bc={bc} />
                    )}
                  </td>

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

function StructuredExpected({
  detail,
  bc,
}: {
  detail?: StructuredDiffDetail
  bc?: BenchCase
}) {
  if (!bc?.expectedStructured) {
    return <span style={{ color: '#aaa' }}>not applicable (no structured key)</span>
  }
  const meds = bc.expectedStructured.medications
  return (
    <details>
      <summary style={{ cursor: 'pointer' }}>
        {meds.length} expected item{meds.length > 1 ? 's' : ''}
      </summary>
      <ul style={{ margin: '4px 0', padding: '0 0 0 12px' }}>
        {meds.map((m, i) => (
          <li key={i}>
            {m.name}
            {m.dose ? ` ${m.dose}` : ''}
          </li>
        ))}
      </ul>
      {detail && detail.fields.length > 0 && (
        <div style={{ marginTop: 4 }}>
          {detail.fields.map((f, i) => (
            <FieldDiffBadge key={i} f={f} />
          ))}
        </div>
      )}
    </details>
  )
}

function FieldDiffBadge({ f }: { f: StructuredFieldDiff }) {
  const tone =
    f.status === 'match' ? '#2a7' : f.status === 'mismatch' ? '#c00' : '#a80'
  return (
    <span
      style={{
        display: 'inline-block',
        margin: '1px 3px 1px 0',
        padding: '0 4px',
        fontSize: '0.7rem',
        borderRadius: 3,
        border: `1px solid ${tone}`,
        color: tone,
      }}
    >
      {f.item}.{f.field}: {f.status}
    </span>
  )
}

// ── Style helpers (mirror DisagreementTable) ─────────────────────────────────

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
