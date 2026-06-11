'use client'

import { REPO_URL } from '@/lib/site'

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
        <span data-testid="scorecard-judge-agreement" title="Agreement with the author's designed labels — not judge-vs-independent-human. The 'judge agrees with the clinician' framing is reserved for the user path, where you are the labeler.">
          Designed-label agreement:{' '}
          <strong>{(judgeReferenceAgreement * 100).toFixed(1)}%</strong>
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
        <strong>Honesty:</strong> The judge is an LLM — it makes mistakes. The 0.85 pass
        threshold was chosen against this seeded set, not calibrated to your use case. The
        human-label comparison uses a small AI-proxy set (strict Haiku vs. lenient Sonnet),
        not a clinical panel. <strong>Designed-label agreement</strong> above is agreement with
        the author&apos;s own designed labels, not judge-vs-independent-human — &quot;the judge
        agrees with the clinician&quot; is reserved for the user path, where you are the labeler.
        Treat these numbers as orientation, not ground truth.
      </div>

      <div
        data-testid="scorecard-self-preference"
        style={{
          padding: '0.5rem 0.75rem',
          background: '#fdf1f1',
          border: '1px solid #e0a0a0',
          borderRadius: 4,
          fontSize: '0.8rem',
          color: '#7a2a2a',
          marginBottom: '0.5rem',
        }}
      >
        <strong>Self-preference:</strong> the seeded outputs are generated and judged within the
        same Haiku model family. A model judging its own family is a documented LLM-judge bias; the
        fixed-judge design is deliberate, but the caveat is named here so the agreement numbers are
        read with it in mind.
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
        <strong>What this sandbox does and doesn&apos;t do:</strong> Your eval cases live in
        your browser only — nothing is stored server-side or shared between users. Two things
        are deliberately absent: <em>accounts</em> (close the tab and the session ends unless
        you export), and <em>custom scorer code</em> (you author rubrics in plain text, not
        code). The judge prompts and the seeded case set are both visible in the Inspector and{' '}
        <a href={REPO_URL} data-testid="scorecard-repo-link" target="_blank" rel="noreferrer">
          in the open source
        </a>
        .
      </div>
    </section>
  )
}
