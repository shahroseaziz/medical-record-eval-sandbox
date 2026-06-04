'use client'

import { useState } from 'react'
import { PatientBrowser, type PatientRow } from './PatientBrowser'
import { PromptEditor } from './PromptEditor'
import { RagModeToggle } from './RagModeToggle'
import { TransformInspector } from './TransformInspector'
import { Inspector } from './Inspector'
import { UserCaseManager } from './UserCaseManager'
import { ApiKeyInput } from './ApiKeyInput'
import { useRun } from '@/hooks/useRun'
import type { UserCase } from '@/lib/cases'
import type { RunMode } from '@/app/api/run/types'

function EvalBadge({ label, score }: { label: string; score: number | null }) {
  const color = score === null ? '#888' : score >= 0.85 ? '#2a7' : score >= 0.5 ? '#a80' : '#c00'
  const text = score === null ? 'N/A' : (score * 100).toFixed(0) + '%'
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: color + '22',
        border: `1px solid ${color}`,
        color,
        borderRadius: 4,
        fontSize: '0.8rem',
        fontWeight: 600,
      }}
    >
      {label}: {text}
    </span>
  )
}

export function Workspace() {
  const [selectedPatient, setSelectedPatient] = useState<PatientRow | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<RunMode>('retrieve')
  const [record, setRecord] = useState('')

  const { text, retrieval, evalResult, trace, loading, error, run } = useRun()

  function handleRun() {
    if (!selectedPatient || !query.trim()) return
    run({
      patientId: selectedPatient.id,
      query,
      mode,
      record: mode === 'stuff' ? record : undefined,
    })
  }

  function handleRunCase(uc: UserCase) {
    setQuery(uc.query)
    setMode(uc.mode)
    if (uc.record) setRecord(uc.record)
    run({
      patientId: uc.patientId,
      query: uc.query,
      mode: uc.mode,
      record: uc.mode === 'stuff' ? uc.record : undefined,
    })
  }

  const canRun = Boolean(selectedPatient && query.trim() && !loading)

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5rem', fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.25rem' }}>Medical Record Eval Sandbox</h1>
      <p style={{ color: '#555', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        Browse synthetic C-CDA patients, craft prompts, toggle RAG mode, run evaluations.
      </p>

      <ApiKeyInput />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* Patient browser */}
      <PatientBrowser
        selectedId={selectedPatient?.id ?? null}
        onSelect={(p) => setSelectedPatient(p)}
      />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* Workspace pane */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {/* Left: controls */}
        <div>
          {selectedPatient && (
            <div
              data-testid="selected-patient"
              style={{
                marginBottom: '0.75rem',
                padding: '0.5rem 0.75rem',
                background: '#f0f7ff',
                border: '1px solid #aaccff',
                borderRadius: 4,
                fontSize: '0.9rem',
              }}
            >
              Selected: <strong>{selectedPatient.summary.demographics.firstName} {selectedPatient.summary.demographics.lastName}</strong>{' '}
              <span style={{ color: '#666', fontSize: '0.8rem' }}>({selectedPatient.id.slice(0, 12)}…)</span>
            </div>
          )}

          <PromptEditor value={query} onChange={setQuery} disabled={loading} />

          <div style={{ marginTop: '0.75rem' }}>
            <RagModeToggle
              mode={mode}
              onChange={setMode}
              record={record}
              onRecordChange={setRecord}
              disabled={loading}
            />
          </div>

          <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button
              data-testid="run-btn"
              onClick={handleRun}
              disabled={!canRun}
              style={{
                padding: '0.45rem 1.2rem',
                fontSize: '1rem',
                background: canRun ? '#0070f3' : '#ccc',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: canRun ? 'pointer' : 'not-allowed',
              }}
            >
              {loading ? 'Running…' : 'Run'}
            </button>

            {!selectedPatient && (
              <span style={{ fontSize: '0.8rem', color: '#888' }}>Select a patient first</span>
            )}
          </div>
        </div>

        {/* Right: results */}
        <div>
          {error && (
            <div
              data-testid="run-error"
              style={{
                padding: '0.5rem 0.75rem',
                background: '#fff0f0',
                border: '1px solid #f5a',
                borderRadius: 4,
                color: '#c00',
                fontSize: '0.85rem',
                marginBottom: '0.75rem',
              }}
            >
              {error}
            </div>
          )}

          {(text || loading) && (
            <div
              data-testid="run-output"
              style={{
                padding: '0.75rem',
                background: '#f9f9f9',
                border: '1px solid #ddd',
                borderRadius: 6,
                minHeight: 80,
                fontFamily: 'inherit',
                fontSize: '0.9rem',
                lineHeight: 1.6,
                marginBottom: '0.75rem',
                whiteSpace: 'pre-wrap',
              }}
            >
              {text || (loading ? '…' : '')}
            </div>
          )}

          {evalResult && (
            <div data-testid="eval-results" style={{ marginBottom: '0.75rem' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: 6 }}>Eval scores:</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <EvalBadge label="faithfulness" score={evalResult.faithfulness.score} />
                <EvalBadge label="section-hit" score={evalResult.sectionHit.score} />
              </div>
              {evalResult.faithfulness.claims.length > 0 && (
                <details style={{ marginTop: 8, fontSize: '0.8rem' }}>
                  <summary style={{ cursor: 'pointer' }}>
                    {evalResult.faithfulness.claims.length} claim(s)
                  </summary>
                  <ul style={{ marginTop: 4, paddingLeft: 16 }}>
                    {evalResult.faithfulness.claims.map((c, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        <span style={{ color: c.verdict === 'supported' ? '#2a7' : c.verdict === 'unsupported' ? '#c00' : '#a80' }}>
                          [{c.verdict}]
                        </span>{' '}
                        {c.claim}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {retrieval && retrieval.chunks.length > 0 && (
            <details data-testid="retrieval-details" style={{ fontSize: '0.82rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                Retrieved {retrieval.chunks.length} chunk(s)
              </summary>
              <ul style={{ paddingLeft: 16, marginTop: 4 }}>
                {retrieval.chunks.map((c, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <strong>{c.section}</strong> (sim: {c.similarity.toFixed(3)})
                    <div style={{ color: '#555', marginTop: 2 }}>{c.text.slice(0, 120)}…</div>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {trace && (
        <>
          <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />
          <Inspector trace={trace} />
        </>
      )}

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* Transform inspector */}
      <TransformInspector
        patientId={selectedPatient?.id ?? null}
        onLoadRecord={setRecord}
      />

      <hr style={{ margin: '1.5rem 0', borderColor: '#eee' }} />

      {/* User case manager */}
      <UserCaseManager
        currentPatientId={selectedPatient?.id ?? null}
        currentQuery={query}
        currentMode={mode}
        currentRecord={record}
        onRunCase={handleRunCase}
      />
    </div>
  )
}
