'use client'

import Link from 'next/link'
import { DisagreementTable } from './DisagreementTable'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'

interface Props {
  results: UserRunCaseResult[]
  threshold: number
  onResetToExample?: () => void
}

export function ExampleHero({ results, threshold, onResetToExample }: Props) {
  return (
    <section
      data-testid="example-hero"
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: '1.5rem 1.5rem 0',
        fontFamily: 'sans-serif',
      }}
    >
      <div
        style={{
          padding: '0.75rem 1rem',
          background: '#f0f4ff',
          border: '1px solid #93c5fd',
          borderRadius: 6,
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: '#1e3a8a', marginBottom: 4 }}>
            Worked Example — pre-computed run
          </div>
          <div style={{ fontSize: '0.82rem', color: '#374151', lineHeight: 1.5 }}>
            A pass, a hallucination the judge catches, and one case where the judge was wrong.
            No network or DB call — rendered from a bundled snapshot produced once by a maintainer.
            Use{' '}
            <strong>Reset workspace to example</strong> to load these cases into the authoring
            tool below.
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            alignItems: 'flex-end',
            flexShrink: 0,
          }}
        >
          {onResetToExample && (
            <button
              data-testid="reset-to-example-btn"
              onClick={onResetToExample}
              style={{
                padding: '0.35rem 0.85rem',
                fontSize: '0.82rem',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Reset workspace to example
            </button>
          )}
          <Link
            href="/example"
            data-testid="example-permalink"
            style={{
              fontSize: '0.78rem',
              color: '#2563eb',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Share this run →
          </Link>
        </div>
      </div>

      <DisagreementTable results={results} initialThreshold={threshold} />
    </section>
  )
}
