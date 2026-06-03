'use client'

import { useState } from 'react'
import { MODEL as EMBEDDING_MODEL, DIM } from '@/lib/voyage'

interface ChunkRow {
  section: string
  ord: number
  text: string
}

interface Props {
  patientId: string | null
  onLoadRecord?: (record: string) => void
}

function groupBySection(chunks: ChunkRow[]): Map<string, ChunkRow[]> {
  const map = new Map<string, ChunkRow[]>()
  for (const c of chunks) {
    const arr = map.get(c.section) ?? []
    arr.push(c)
    map.set(c.section, arr)
  }
  return map
}

export function TransformInspector({ patientId, onLoadRecord }: Props) {
  const [open, setOpen] = useState(false)
  const [chunks, setChunks] = useState<ChunkRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetched, setFetched] = useState<string | null>(null)

  async function load() {
    if (!patientId) return
    if (fetched === patientId) { setOpen(true); return }

    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}/chunks`)
      const data = (await res.json()) as { chunks?: ChunkRow[]; error?: string }
      if (!res.ok || data.error) {
        setError(data.error ?? 'Failed to load chunks')
      } else {
        setChunks(data.chunks ?? [])
        setFetched(patientId)
        setOpen(true)
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  function handleLoadRecord() {
    if (!onLoadRecord || chunks.length === 0) return
    const grouped = groupBySection(chunks)
    const parts: string[] = []
    for (const [section, sChunks] of grouped) {
      parts.push(`=== ${section} ===`)
      for (const c of sChunks) parts.push(c.text)
    }
    onLoadRecord(parts.join('\n\n'))
  }

  if (!patientId) {
    return (
      <section style={{ marginTop: '1rem', padding: '0.75rem', border: '1px solid #ddd', borderRadius: 6, background: '#fafafa' }}>
        <p style={{ fontSize: '0.85rem', color: '#888', margin: 0 }}>
          Select a patient to inspect parse → chunk → embed pipeline.
        </p>
      </section>
    )
  }

  const grouped = groupBySection(chunks)

  return (
    <section style={{ marginTop: '1rem', padding: '0.75rem', border: '1px solid #ddd', borderRadius: 6, background: '#fafafa' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
        <h3 style={{ fontSize: '0.95rem', margin: 0 }}>Transform Inspector — parse → chunk → embed</h3>
        <button
          data-testid="inspect-btn"
          onClick={open ? () => setOpen(false) : load}
          disabled={loading}
          style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
        >
          {loading ? 'Loading…' : open ? 'Hide' : 'Inspect'}
        </button>
        {onLoadRecord && chunks.length > 0 && (
          <button
            data-testid="load-record-btn"
            onClick={handleLoadRecord}
            style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
          >
            Load chunks as record (stuff mode)
          </button>
        )}
      </div>

      {error && <p style={{ color: '#c00', fontSize: '0.85rem', marginTop: 8 }}>{error}</p>}

      {open && chunks.length > 0 && (
        <div style={{ marginTop: '0.75rem' }}>
          {/* Embed metadata */}
          <div style={{ marginBottom: '0.75rem', padding: '0.5rem', background: '#e8f4e8', borderRadius: 4, fontSize: '0.8rem' }}>
            <strong>Embedding:</strong> model = {EMBEDDING_MODEL}, dim = {DIM}, {chunks.length} chunk(s) embedded
          </div>

          {/* Sections / chunks */}
          {Array.from(grouped.entries()).map(([section, sChunks]) => (
            <details key={section} style={{ marginBottom: '0.5rem' }}>
              <summary style={{ cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>
                {section} — {sChunks.length} chunk(s)
              </summary>
              {sChunks.map((c) => (
                <pre
                  key={`${section}-${c.ord}`}
                  style={{
                    background: '#f5f5f5',
                    border: '1px solid #ddd',
                    borderRadius: 4,
                    padding: '0.5rem',
                    fontSize: '0.75rem',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    marginTop: 4,
                  }}
                >
                  {c.text}
                </pre>
              ))}
            </details>
          ))}
        </div>
      )}
    </section>
  )
}
