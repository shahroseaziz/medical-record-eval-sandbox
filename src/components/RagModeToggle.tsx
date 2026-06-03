'use client'

import type { RunMode } from '@/app/api/run/types'

interface Props {
  mode: RunMode
  onChange: (m: RunMode) => void
  record: string
  onRecordChange: (r: string) => void
  disabled?: boolean
}

export function RagModeToggle({ mode, onChange, record, onRecordChange, disabled }: Props) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>RAG mode:</span>
        <button
          data-testid="mode-toggle"
          onClick={() => onChange(mode === 'retrieve' ? 'stuff' : 'retrieve')}
          disabled={disabled}
          style={{
            padding: '0.3rem 0.8rem',
            background: mode === 'retrieve' ? '#e0f0ff' : '#fff0e0',
            border: '1px solid #aaa',
            borderRadius: 4,
            cursor: disabled ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}
        >
          {mode === 'retrieve' ? 'retrieve (vector search)' : 'stuff (full record)'}
        </button>
      </div>

      {mode === 'stuff' && (
        <div>
          <label htmlFor="record-input" style={{ display: 'block', fontSize: '0.85rem', marginBottom: 4 }}>
            Record text (paste full C-CDA narrative or use &ldquo;Load from patient&rdquo; button)
          </label>
          <textarea
            id="record-input"
            data-testid="record-input"
            value={record}
            onChange={(e) => onRecordChange(e.target.value)}
            disabled={disabled}
            rows={8}
            placeholder="Paste the full record text here, or select a patient and click Load Chunks as Record."
            style={{
              width: '100%',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              padding: '0.4rem 0.6rem',
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}
    </div>
  )
}
