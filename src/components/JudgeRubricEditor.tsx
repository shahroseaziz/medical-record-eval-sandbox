'use client'

export const DEFAULT_VERDICT_RUBRIC = `For each claim assign:
- "supported": directly and explicitly supported by the context
- "unsupported": contradicted by the context, or not present at all
- "partial": mentioned but with caveats, hedging, or incomplete coverage

Evaluate strictly. A claim is NOT supported unless the context explicitly backs it.`

export interface RescoreResult {
  score: number | null
  errored?: boolean
  errorMessage?: string
  zeroClaimFlag?: boolean
  claims: Array<{
    claim: string
    verdict: 'supported' | 'unsupported' | 'partial'
    reason: string
  }>
  groundingSource?: string
}

interface Props {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  canRescore?: boolean
  onRescore?: () => void
  rescoring?: boolean
  rescoreResult?: RescoreResult | null
  rescoreError?: string | null
}

export function JudgeRubricEditor({
  value,
  onChange,
  disabled,
  canRescore,
  onRescore,
  rescoring,
  rescoreResult,
  rescoreError,
}: Props) {
  const isDefault = value === DEFAULT_VERDICT_RUBRIC

  return (
    <div
      data-testid="judge-rubric-editor"
      style={{
        border: '1.5px solid #2563eb',
        borderRadius: 6,
        background: '#f0f4ff',
        padding: '0.75rem',
        marginTop: '0.75rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <label
          htmlFor="judge-rubric-input"
          style={{ fontSize: '0.9rem', fontWeight: 600, color: '#1e3a8a' }}
        >
          verdict rubric (applied per-claim)
        </label>
        <button
          data-testid="reset-judge-rubric-btn"
          onClick={() => onChange(DEFAULT_VERDICT_RUBRIC)}
          disabled={disabled || rescoring || isDefault}
          style={{
            fontSize: '0.75rem',
            padding: '2px 8px',
            background: 'none',
            border: '1px solid #2563eb',
            color: '#1e3a8a',
            borderRadius: 3,
            cursor: disabled || rescoring || isDefault ? 'default' : 'pointer',
            opacity: isDefault ? 0.4 : 1,
          }}
        >
          Reset to example
        </button>
      </div>

      <div
        data-testid="judge-rubric-warning"
        style={{
          fontSize: '0.75rem',
          color: '#7a5c00',
          background: '#fff3cd',
          border: '1px solid #ffc107',
          borderRadius: 3,
          padding: '3px 8px',
          marginBottom: 6,
        }}
      >
        Synthetic data only — do not paste real patient data.
      </div>

      <textarea
        id="judge-rubric-input"
        data-testid="judge-rubric-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || rescoring}
        rows={6}
        style={{
          width: '100%',
          fontFamily: 'monospace',
          fontSize: '0.8rem',
          padding: '0.4rem 0.6rem',
          resize: 'vertical',
          boxSizing: 'border-box',
          background: disabled || rescoring ? '#f5f5f5' : '#f8faff',
          border: '1px solid #93c5fd',
          borderRadius: 4,
        }}
      />

      <div style={{ marginTop: '0.5rem', display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          data-testid="rescore-btn"
          onClick={onRescore}
          disabled={disabled || rescoring || !canRescore || !onRescore}
          style={{
            padding: '0.35rem 0.9rem',
            fontSize: '0.85rem',
            background: disabled || rescoring || !canRescore ? '#ccc' : '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: disabled || rescoring || !canRescore ? 'not-allowed' : 'pointer',
          }}
        >
          {rescoring ? 'Scoring…' : 'Re-score'}
        </button>
        {!canRescore && (
          <span style={{ fontSize: '0.75rem', color: '#888' }}>
            Run first to enable re-score
          </span>
        )}
      </div>

      {rescoreError && (
        <div
          data-testid="rescore-error"
          style={{
            marginTop: '0.5rem',
            padding: '0.4rem 0.6rem',
            background: '#fff0f0',
            border: '1px solid #f5a',
            borderRadius: 4,
            color: '#c00',
            fontSize: '0.82rem',
          }}
        >
          {rescoreError}
        </div>
      )}

      {rescoreResult && (
        <div
          data-testid="rescore-result"
          style={{
            marginTop: '0.75rem',
            padding: '0.5rem 0.75rem',
            background: '#fff',
            border: '1px solid #93c5fd',
            borderRadius: 4,
          }}
        >
          <div
            style={{ fontWeight: 600, fontSize: '0.85rem', marginBottom: 6, color: '#1e3a8a' }}
          >
            Re-score result:{' '}
            <span
              style={{
                color:
                  rescoreResult.score === null
                    ? '#888'
                    : rescoreResult.score >= 0.85
                      ? '#2a7'
                      : rescoreResult.score >= 0.5
                        ? '#a80'
                        : '#c00',
              }}
            >
              {rescoreResult.score === null
                ? 'N/A'
                : (rescoreResult.score * 100).toFixed(0) + '%'}
            </span>
          </div>
          {rescoreResult.errored && (
            <div style={{ color: '#c00', fontSize: '0.8rem' }}>{rescoreResult.errorMessage}</div>
          )}
          {rescoreResult.claims.length > 0 && (
            <ul style={{ paddingLeft: 16, margin: 0, fontSize: '0.8rem' }}>
              {rescoreResult.claims.map((c, i) => (
                <li key={i} data-testid={`rescore-claim-${i}`} style={{ marginBottom: 3 }}>
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        c.verdict === 'supported'
                          ? '#2a7'
                          : c.verdict === 'unsupported'
                            ? '#c00'
                            : '#a80',
                    }}
                  >
                    [{c.verdict}]
                  </span>{' '}
                  {c.claim}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
