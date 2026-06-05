export const dynamic = 'force-static'

import Link from 'next/link'
import { DisagreementTable } from '@/components/DisagreementTable'
import exampleData from '@/example/eval-example.json'
import type { UserRunCaseResult } from '@/lib/eval/user-agreement'

export default function ExamplePage() {
  const results = exampleData.results as UserRunCaseResult[]
  const threshold = exampleData.threshold

  return (
    <div
      data-testid="example-permalink-page"
      style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5rem', fontFamily: 'sans-serif' }}
    >
      <div style={{ marginBottom: '1rem' }}>
        <Link
          href="/"
          style={{ fontSize: '0.85rem', color: '#2563eb', textDecoration: 'none' }}
        >
          ← Medical Record Eval Sandbox
        </Link>
      </div>

      <h1 style={{ fontSize: '1.3rem', marginBottom: '0.25rem' }}>
        Worked Example Run
      </h1>
      <p style={{ color: '#555', fontSize: '0.88rem', marginBottom: '1.25rem' }}>
        Read-only snapshot — produced once by a maintainer. No database or model calls.
        Generated: {exampleData.generatedAt}
      </p>

      <div
        data-testid="example-static-note"
        style={{
          padding: '0.6rem 0.9rem',
          background: '#f0f4ff',
          border: '1px solid #93c5fd',
          borderRadius: 6,
          fontSize: '0.82rem',
          color: '#1e3a8a',
          marginBottom: '1.25rem',
        }}
      >
        <strong>Teaching moment:</strong> the highlighted row shows a case where
        the judge scored a hallucination as faithful. The human annotator caught
        the error — this is why judges are validated, not trusted.
      </div>

      <DisagreementTable results={results} initialThreshold={threshold} />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      <details style={{ fontSize: '0.82rem', color: '#555' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>
          Prompts used
        </summary>
        <div style={{ marginTop: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Generation prompt</div>
          <pre
            style={{
              background: '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: 4,
              padding: '0.5rem',
              whiteSpace: 'pre-wrap',
              fontSize: '0.78rem',
              margin: '0 0 1rem',
            }}
          >
            {exampleData.generationPrompt}
          </pre>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Judge rubric</div>
          <pre
            style={{
              background: '#f5f5f5',
              border: '1px solid #ddd',
              borderRadius: 4,
              padding: '0.5rem',
              whiteSpace: 'pre-wrap',
              fontSize: '0.78rem',
              margin: 0,
            }}
          >
            {exampleData.judgeRubric}
          </pre>
        </div>
      </details>

      <div style={{ marginTop: '1.5rem' }}>
        <Link
          href="/"
          style={{
            display: 'inline-block',
            padding: '0.4rem 1rem',
            background: '#2563eb',
            color: '#fff',
            borderRadius: 4,
            textDecoration: 'none',
            fontSize: '0.88rem',
          }}
        >
          Author your own run →
        </Link>
      </div>
    </div>
  )
}
