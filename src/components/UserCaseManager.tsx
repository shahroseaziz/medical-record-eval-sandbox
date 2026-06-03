'use client'

import { useState, useEffect } from 'react'
import type { UserCase } from '@/lib/cases'
import { loadUserCases, saveUserCase, deleteUserCase } from '@/lib/cases'
import type { RunMode } from '@/app/api/run/types'

interface Props {
  currentPatientId: string | null
  currentQuery: string
  currentMode: RunMode
  currentRecord: string
  onRunCase: (uc: UserCase) => void
}

export function UserCaseManager({
  currentPatientId,
  currentQuery,
  currentMode,
  currentRecord,
  onRunCase,
}: Props) {
  const [cases, setCases] = useState<UserCase[]>([])
  const [caseName, setCaseName] = useState('')
  const [savedFeedback, setSavedFeedback] = useState(false)

  useEffect(() => {
    setCases(loadUserCases())
  }, [])

  function refresh() {
    setCases(loadUserCases())
  }

  function handleSave() {
    if (!currentPatientId || !currentQuery.trim()) return
    const id = `user-${Date.now()}`
    const uc: UserCase = {
      id,
      patientId: currentPatientId,
      query: currentQuery,
      mode: currentMode,
      record: currentMode === 'stuff' ? currentRecord : undefined,
      createdAt: Date.now(),
    }
    saveUserCase(uc)
    setCaseName('')
    refresh()
    setSavedFeedback(true)
    setTimeout(() => setSavedFeedback(false), 2000)
  }

  function handleDelete(id: string) {
    deleteUserCase(id)
    refresh()
  }

  return (
    <section style={{ marginTop: '1rem', padding: '0.75rem', border: '1px solid #ddd', borderRadius: 6 }}>
      <h3 style={{ fontSize: '0.95rem', marginTop: 0, marginBottom: '0.5rem' }}>My Cases</h3>

      <p style={{ fontSize: '0.78rem', color: '#666', margin: '0 0 0.5rem' }}>
        User cases are stored in <code>localStorage</code> only. They never contribute to the
        seeded aggregate, agreement, or kappa metrics.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          placeholder="Case label (optional)"
          value={caseName}
          onChange={(e) => setCaseName(e.target.value)}
          style={{ flex: 1, minWidth: 120, padding: '0.3rem 0.5rem', fontSize: '0.85rem' }}
          data-testid="case-name-input"
        />
        <button
          data-testid="save-case-btn"
          onClick={handleSave}
          disabled={!currentPatientId || !currentQuery.trim()}
          style={{ padding: '0.3rem 0.7rem', fontSize: '0.85rem' }}
        >
          {savedFeedback ? 'Saved!' : 'Save current as case'}
        </button>
      </div>

      {cases.length === 0 && (
        <p style={{ fontSize: '0.82rem', color: '#999', margin: 0 }}>No saved cases yet.</p>
      )}

      {cases.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cases.map((uc) => (
            <li
              key={uc.id}
              data-testid={`user-case-${uc.id}`}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '0.5rem',
                padding: '0.5rem',
                border: '1px solid #e0e0e0',
                borderRadius: 4,
                background: '#fafafa',
              }}
            >
              <div style={{ flex: 1, fontSize: '0.82rem' }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  [{uc.mode}] patient: {uc.patientId.slice(0, 12)}…
                </div>
                <div style={{ color: '#444', wordBreak: 'break-word' }}>
                  {uc.query.slice(0, 120)}{uc.query.length > 120 ? '…' : ''}
                </div>
                <div style={{ color: '#888', fontSize: '0.75rem', marginTop: 2 }}>
                  {new Date(uc.createdAt).toLocaleString()}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button
                  onClick={() => onRunCase(uc)}
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem' }}
                  data-testid={`run-case-${uc.id}`}
                >
                  Run
                </button>
                <button
                  onClick={() => handleDelete(uc.id)}
                  style={{ padding: '0.2rem 0.5rem', fontSize: '0.8rem', color: '#c00' }}
                  data-testid={`delete-case-${uc.id}`}
                >
                  Del
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
