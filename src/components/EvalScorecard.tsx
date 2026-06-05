'use client'

export interface ScorecardAggregate {
  passRate: number
  judgeReferenceAgreement: number
  judgeHumanKappa: number | null
  interHumanKappa?: number | null
  n: number
}

export interface ScorecardCase {
  id: string
  label: string
  faithfulnessScore: number
  pass: boolean
}

export interface EvalScorecardProps {
  aggregate: ScorecardAggregate
  cases: ScorecardCase[]
}

function fmtKappa(k: number | null | undefined): string {
  return k == null ? 'N/A' : k.toFixed(2)
}

export function EvalScorecard({ aggregate, cases }: EvalScorecardProps) {
  const { passRate, judgeReferenceAgreement, judgeHumanKappa, interHumanKappa, n } = aggregate

  return (
    <section data-testid="eval-scorecard" style={{ fontSize: '0.9rem' }}>
      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Eval Scorecard</h2>

      <div
        data-testid="scorecard-aggregate"
        style={{
          display: 'flex',
          gap: '1.25rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
          padding: '0.6rem 0.75rem',
          background: '#f7f7f7',
          border: '1px solid #ddd',
          borderRadius: 6,
        }}
      >
        <span data-testid="scorecard-pass-rate">
          Pass rate: <strong>{(passRate * 100).toFixed(1)}%</strong>
        </span>
        <span data-testid="scorecard-judge-agreement">
          Judge-vs-reference: <strong>{(judgeReferenceAgreement * 100).toFixed(1)}%</strong>
        </span>
        <span data-testid="scorecard-kappa-judge-human">
          Judge–human agreement: <strong>{fmtKappa(judgeHumanKappa)}</strong>
        </span>
        <span data-testid="scorecard-kappa-inter-human">
          Inter-human agreement: <strong>{fmtKappa(interHumanKappa)}</strong>
        </span>
        <span style={{ color: '#888', fontSize: '0.82rem' }}>n={n}</span>
      </div>

      <ul
        data-testid="scorecard-case-list"
        style={{ padding: 0, margin: '0 0 0.75rem 0', listStyle: 'none' }}
      >
        {cases.map((c) => {
          const color = c.pass ? '#2a7' : '#c00'
          return (
            <li
              key={c.id}
              data-testid={`scorecard-case-${c.id}`}
              style={{
                display: 'flex',
                gap: '0.75rem',
                alignItems: 'center',
                padding: '0.3rem 0',
                borderBottom: '1px solid #eee',
                fontSize: '0.85rem',
              }}
            >
              <span
                style={{
                  display: 'inline-block',
                  minWidth: 38,
                  textAlign: 'center',
                  padding: '1px 6px',
                  background: color + '22',
                  border: `1px solid ${color}`,
                  color,
                  borderRadius: 3,
                  fontWeight: 600,
                  fontSize: '0.78rem',
                  flexShrink: 0,
                }}
              >
                {c.pass ? 'PASS' : 'FAIL'}
              </span>
              <span style={{ flex: 1 }}>{c.label}</span>
              <span style={{ color: '#666' }}>faith: {c.faithfulnessScore.toFixed(2)}</span>
            </li>
          )
        })}
      </ul>

      <div
        data-testid="scorecard-honesty-note"
        style={{
          padding: '0.5rem 0.75rem',
          background: '#fffbec',
          border: '1px solid #e8d060',
          borderRadius: 4,
          fontSize: '0.8rem',
          color: '#665a00',
          marginBottom: '0.5rem',
        }}
      >
        <strong>Honesty:</strong> LLM judge — can be wrong; threshold chosen, not calibrated; human labels are a small proxy set
      </div>

      <div
        data-testid="scorecard-scope-note"
        style={{
          padding: '0.5rem 0.75rem',
          background: '#f5f5f5',
          border: '1px solid #ccc',
          borderRadius: 4,
          fontSize: '0.8rem',
          color: '#555',
        }}
      >
        <strong>Scope:</strong> v1 sandbox; custom scorers, full golden-set builder, and cohort RAG are roadmapped
      </div>
    </section>
  )
}
