'use client'

import { useState } from 'react'

export interface PatientSummary {
  demographics: {
    firstName: string
    lastName: string
    gender: string
    birthDate: string
  }
  sections: string[]
}

export interface PatientRow {
  id: string
  name: string
  summary: PatientSummary
}

interface Props {
  selectedId: string | null
  onSelect: (patient: PatientRow) => void
}

function formatBirthDate(raw: string): string {
  if (raw.length !== 8) return raw
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
}

function PatientCard({
  patient,
  selected,
  onSelect,
}: {
  patient: PatientRow
  selected: boolean
  onSelect: () => void
}) {
  const [showRaw, setShowRaw] = useState(false)
  const { demographics, sections } = patient.summary

  return (
    <div
      data-testid={`patient-card-${patient.id}`}
      onClick={onSelect}
      style={{
        border: selected ? '2px solid #0070f3' : '1px solid #ccc',
        borderRadius: 6,
        padding: '0.75rem',
        cursor: 'pointer',
        background: selected ? '#f0f7ff' : '#fff',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: 4 }}>
        {demographics.firstName} {demographics.lastName}
      </div>
      <div style={{ fontSize: '0.8rem', color: '#555', marginBottom: 6 }}>
        DOB: {formatBirthDate(demographics.birthDate)} · {demographics.gender === 'M' ? 'Male' : demographics.gender === 'F' ? 'Female' : demographics.gender}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation()
          setShowRaw((v) => !v)
        }}
        style={{ fontSize: '0.75rem', padding: '2px 6px', marginBottom: 6 }}
      >
        {showRaw ? 'Parsed view' : 'Raw chunks'}
      </button>

      {showRaw ? (
        <div style={{ fontSize: '0.75rem', color: '#444', fontFamily: 'monospace' }}>
          sections: {JSON.stringify(sections)}
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {sections.map((s) => (
            <span
              key={s}
              style={{
                background: '#e8f4e8',
                border: '1px solid #a3d9a3',
                borderRadius: 3,
                padding: '1px 5px',
                fontSize: '0.72rem',
              }}
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function PatientBrowser({ selectedId, onSelect }: Props) {
  const [patients, setPatients] = useState<PatientRow[]>([])
  const [n, setN] = useState(5)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchPatients() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/patients?n=${n}`)
      const data = (await res.json()) as { patients?: PatientRow[]; error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? 'Failed to load patients')
      } else {
        setPatients(data.patients ?? [])
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section>
      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.5rem' }}>Patient Browser</h2>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <label htmlFor="patient-count" style={{ fontSize: '0.9rem' }}>
          N =
        </label>
        <input
          id="patient-count"
          type="number"
          min={1}
          max={20}
          value={n}
          onChange={(e) => setN(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))}
          style={{ width: 60, padding: '0.3rem' }}
        />
        <button
          data-testid="get-patients-btn"
          onClick={fetchPatients}
          disabled={loading}
          style={{ padding: '0.35rem 0.8rem' }}
        >
          {loading ? 'Loading…' : `Get ${n} Random Patients`}
        </button>
      </div>

      {error && (
        <p style={{ color: '#c00', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{error}</p>
      )}

      {patients.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '0.75rem' }}>
          {patients.map((p) => (
            <PatientCard
              key={p.id}
              patient={p}
              selected={p.id === selectedId}
              onSelect={() => onSelect(p)}
            />
          ))}
        </div>
      )}

      {patients.length === 0 && !loading && (
        <p style={{ fontSize: '0.85rem', color: '#888' }}>
          Click the button above to browse synthetic patients.
        </p>
      )}
    </section>
  )
}
