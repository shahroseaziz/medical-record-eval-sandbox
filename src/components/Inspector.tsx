'use client'

import type { RunTrace } from '@/app/api/run/types'
import type { FaithfulnessResult } from '@/lib/eval/types'

export interface BaselineEntry {
  meanScore: number
  scoreStdDev: number
}

interface InspectorProps {
  trace: RunTrace
  baselineEntry?: BaselineEntry
}

export function Inspector({ trace, baselineEntry }: InspectorProps) {
  const { retrieval, sectionHit, scorerResults } = trace

  const faithfulness = scorerResults.find(
    (r): r is FaithfulnessResult => r.scorer === 'faithfulness',
  )

  const total =
    sectionHit.requiredSections.length > 0
      ? sectionHit.requiredSections.length
      : sectionHit.retrievedSections.length

  return (
    <div data-testid="inspector" style={{ fontSize: '0.85rem', fontFamily: 'inherit' }}>
      <h3 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>Run Inspector</h3>

      {/* ── Chunks ── */}
      {retrieval && (
        <section style={{ marginBottom: '1rem' }}>
          <div
            data-testid="chunks-summary"
            style={{ fontWeight: 600, marginBottom: '0.4rem' }}
          >
            retrieved {sectionHit.retrievedSections.length} of {total} sections
          </div>

          <ul style={{ paddingLeft: 16, margin: 0 }}>
            {retrieval.chunks.map((chunk, i) => (
              <li key={i} data-testid={`chunk-${i}`} style={{ marginBottom: '0.4rem' }}>
                <strong>{chunk.section}</strong>{' '}
                <span data-testid={`chunk-${i}-distance`} style={{ color: '#666' }}>
                  dist: {chunk.distance.toFixed(4)}
                </span>{' '}
                <span data-testid={`chunk-${i}-similarity`} style={{ color: '#338' }}>
                  sim: {chunk.similarity.toFixed(4)}
                </span>
                <div style={{ color: '#444', marginTop: 2 }}>{chunk.text.slice(0, 120)}</div>
              </li>
            ))}
          </ul>

          {/* ── Assembled prompt ── */}
          {retrieval.assembledPrompt && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Assembled prompt</summary>
              <pre
                data-testid="assembled-prompt"
                style={{
                  whiteSpace: 'pre-wrap',
                  background: '#f5f5f5',
                  padding: '0.5rem',
                  borderRadius: 4,
                  marginTop: '0.25rem',
                  fontSize: '0.8rem',
                }}
              >
                {retrieval.assembledPrompt}
              </pre>
            </details>
          )}
        </section>
      )}

      {/* ── Judge rubric ── */}
      {faithfulness && (
        <section style={{ marginBottom: '1rem' }}>
          <details>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Judge rubric</summary>
            <div style={{ marginTop: '0.25rem' }}>
              <div style={{ fontWeight: 600, marginBottom: 2 }}>Extract prompt:</div>
              <pre
                data-testid="extract-prompt"
                style={{
                  whiteSpace: 'pre-wrap',
                  background: '#f5f5f5',
                  padding: '0.4rem',
                  borderRadius: 4,
                  fontSize: '0.78rem',
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {faithfulness.extractPrompt}
              </pre>
              <div style={{ fontWeight: 600, marginBottom: 2, marginTop: '0.4rem' }}>
                Verdict prompt:
              </div>
              <pre
                data-testid="verdict-prompt"
                style={{
                  whiteSpace: 'pre-wrap',
                  background: '#f5f5f5',
                  padding: '0.4rem',
                  borderRadius: 4,
                  fontSize: '0.78rem',
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                {faithfulness.verdictPrompt}
              </pre>
            </div>
          </details>

          {/* ── Rationale per claim ── */}
          {faithfulness.claims.length > 0 && (
            <ul style={{ paddingLeft: 16, marginTop: '0.5rem' }}>
              {faithfulness.claims.map((claim, i) => (
                <li key={i} style={{ marginBottom: '0.35rem' }}>
                  <span
                    style={{
                      color:
                        claim.verdict === 'supported'
                          ? '#2a7'
                          : claim.verdict === 'unsupported'
                            ? '#c00'
                            : '#a80',
                      fontWeight: 600,
                    }}
                  >
                    [{claim.verdict}]
                  </span>{' '}
                  {claim.claim}
                  <div
                    data-testid={`rationale-${i}`}
                    style={{ color: '#555', fontSize: '0.78rem', marginTop: 2 }}
                  >
                    {claim.rationale}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Section hit ── */}
      <div data-testid="section-hit" style={{ marginBottom: '0.5rem' }}>
        section_hit:{' '}
        <strong>
          {sectionHit.score === null ? 'N/A' : sectionHit.score === 1 ? '✓' : '✗'}
        </strong>
        {sectionHit.requiredSections.length > 0 && (
          <span style={{ color: '#666', marginLeft: 6 }}>
            ({sectionHit.retrievedSections.join(', ')})
          </span>
        )}
      </div>

      {/* ── Baseline comparison ── */}
      {baselineEntry && (
        <div
          data-testid="baseline-entry"
          style={{
            padding: '0.4rem 0.75rem',
            background: '#f0f7ff',
            border: '1px solid #aaccff',
            borderRadius: 4,
            marginTop: '0.5rem',
          }}
        >
          Baseline mean: <strong>{baselineEntry.meanScore.toFixed(2)}</strong> ±{' '}
          {baselineEntry.scoreStdDev.toFixed(2)}
        </div>
      )}
    </div>
  )
}
