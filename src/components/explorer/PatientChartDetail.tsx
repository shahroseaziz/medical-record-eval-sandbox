'use client'

/*
 * PatientChartDetail (N7b) — per-patient chart detail rendered inside the
 * Explore-the-data drawer. A row click in the all-patients table opens this view
 * for that patient. Visual reference: design/reference/notebook/drawer.jsx
 * (parsed chart → raw XML toggle).
 *
 * Data source: GET /api/patients/[id]/chunks. Each row is { section, ord, text,
 * source_xml }. We group chunks by clinical section (Problems, Medications, Labs,
 * Encounters, …) preserving server order, render the parsed narrative text per
 * section, and offer a Parsed / Raw-XML toggle that shows the section-level
 * `source_xml`. A section whose `source_xml` is null shows a named "raw XML
 * unavailable" state — never a blank panel.
 *
 * PERFORMANCE (acceptance: the ~6 MB outlier patient must open and scroll WITHOUT
 * freezing): two dependency-free techniques combine —
 *   1. Progressive reveal — each section renders an initial batch of chunks with a
 *      "Show N more" button, so opening never does one giant synchronous render of
 *      every chunk in the (very long) labs/results section.
 *   2. CSS `content-visibility: auto` on each chunk block (see the module CSS), so
 *      off-screen chunks are skipped during layout/paint while scrolling.
 * The toggle state resets cleanly per patient: this component is keyed by patient
 * id at the call site, so switching patients (or reopening the drawer) remounts it
 * with `raw = false`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChunkRow, ChunksResponse, ExplorerPatient } from './types'
import styles from './PatientChartDetail.module.css'

/** Server section keys → human labels. `results` surfaces as "Labs" per the spec. */
const SECTION_LABELS: Record<string, string> = {
  problems: 'Problems',
  medications: 'Medications',
  allergies: 'Allergies',
  results: 'Labs',
  encounters: 'Encounters',
  immunizations: 'Immunizations',
  vitals: 'Vitals',
}

/** Stable section ordering: the clinically primary sections first, the rest after. */
const SECTION_ORDER = [
  'problems',
  'medications',
  'allergies',
  'results',
  'encounters',
  'immunizations',
  'vitals',
]

/** Initial chunks rendered per section before the "Show more" affordance. */
const INITIAL_CHUNKS = 25
/** How many additional chunks each "Show more" click reveals. */
const CHUNK_STEP = 50

function sectionLabel(section: string): string {
  return SECTION_LABELS[section] ?? section.charAt(0).toUpperCase() + section.slice(1)
}

interface GroupedSection {
  section: string
  label: string
  chunks: ChunkRow[]
  /** First non-null source_xml across the section's chunks (they share one). */
  sourceXml: string | null
}

function groupBySection(chunks: ChunkRow[]): GroupedSection[] {
  const map = new Map<string, ChunkRow[]>()
  for (const c of chunks) {
    const list = map.get(c.section)
    if (list) list.push(c)
    else map.set(c.section, [c])
  }
  const groups: GroupedSection[] = []
  for (const [section, list] of map) {
    list.sort((a, b) => a.ord - b.ord)
    groups.push({
      section,
      label: sectionLabel(section),
      chunks: list,
      sourceXml: list.find((c) => c.source_xml != null)?.source_xml ?? null,
    })
  }
  // Known sections in clinical order; any unexpected section trails alphabetically.
  groups.sort((a, b) => {
    const ai = SECTION_ORDER.indexOf(a.section)
    const bi = SECTION_ORDER.indexOf(b.section)
    if (ai !== -1 && bi !== -1) return ai - bi
    if (ai !== -1) return -1
    if (bi !== -1) return 1
    return a.section.localeCompare(b.section)
  })
  return groups
}

/** Parsed-narrative view of one section, with progressive chunk reveal (perf). */
function ParsedSection({ group }: { group: GroupedSection }) {
  const [visible, setVisible] = useState(INITIAL_CHUNKS)
  const shown = group.chunks.slice(0, visible)
  const remaining = group.chunks.length - shown.length

  return (
    <section className={styles.section} data-testid={`section-${group.section}`}>
      <div className={styles.secHead}>
        <span className={styles.secTitle}>{group.label}</span>
        <span className={styles.secCount}>{group.chunks.length}</span>
      </div>
      <div className={styles.rows}>
        {shown.map((c) => (
          <div key={c.ord} className={styles.chunk}>
            {c.text?.trim() ? c.text : <span className={styles.empty}>(no narrative text)</span>}
          </div>
        ))}
      </div>
      {remaining > 0 ? (
        <button
          type="button"
          className={styles.showMore}
          onClick={() => setVisible((v) => v + CHUNK_STEP)}
          data-testid={`show-more-${group.section}`}
        >
          Show {Math.min(remaining, CHUNK_STEP)} more
        </button>
      ) : null}
    </section>
  )
}

/** Raw-XML view of one section, or a named unavailable state when source_xml is null. */
function RawSection({ group }: { group: GroupedSection }) {
  return (
    <section className={styles.section} data-testid={`raw-section-${group.section}`}>
      <div className={styles.secHead}>
        <span className={styles.secTitle}>{group.label}</span>
      </div>
      {group.sourceXml != null ? (
        <pre className={styles.rawXml}>{group.sourceXml}</pre>
      ) : (
        <div className={styles.rawUnavailable} data-testid={`raw-unavailable-${group.section}`}>
          Raw XML unavailable for this section.
        </div>
      )}
    </section>
  )
}

export interface PatientChartDetailProps {
  patient: ExplorerPatient
  /** Test seam: override the chunks endpoint. Production derives it from the id. */
  endpoint?: string
}

export function PatientChartDetail({ patient, endpoint }: PatientChartDetailProps) {
  const [chunks, setChunks] = useState<ChunkRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Fresh per mount → toggle state resets cleanly per patient (keyed at call site).
  const [raw, setRaw] = useState(false)
  const url = endpoint ?? `/api/patients/${encodeURIComponent(patient.id)}/chunks`
  const seq = useRef(0)

  useEffect(() => {
    const ticket = ++seq.current
    setLoading(true)
    setError(null)
    setChunks(null)
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(url)
        const data = (await res.json()) as ChunksResponse
        if (!res.ok || data.error) throw new Error(data.error ?? `Failed to load chart (${res.status})`)
        if (!cancelled && ticket === seq.current) setChunks(data.chunks ?? [])
      } catch (err) {
        if (!cancelled && ticket === seq.current) {
          setError(err instanceof Error ? err.message : 'Failed to load chart')
        }
      } finally {
        if (!cancelled && ticket === seq.current) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url])

  const groups = useMemo(() => (chunks ? groupBySection(chunks) : []), [chunks])

  return (
    <div className={styles.detail} data-testid="patient-chart-detail">
      <div className={styles.head}>
        <div className={styles.ident}>
          <div className={styles.name}>{patient.name}</div>
          <div className={styles.meta}>
            {patient.age != null ? `${patient.age} ` : ''}
            {patient.sex || ''}
            {patient.conditionCount != null ? ` · ${patient.conditionCount} cond` : ''}
            {patient.medCount != null ? ` · ${patient.medCount} meds` : ''}
          </div>
        </div>
        <div className={styles.seg} role="group" aria-label="Chart view">
          <button
            type="button"
            className={`${styles.segBtn} ${!raw ? styles.segOn : ''}`}
            aria-pressed={!raw}
            onClick={() => setRaw(false)}
            data-testid="view-parsed"
          >
            Parsed
          </button>
          <button
            type="button"
            className={`${styles.segBtn} ${raw ? styles.segOn : ''}`}
            aria-pressed={raw}
            onClick={() => setRaw(true)}
            data-testid="view-raw"
          >
            Raw XML
          </button>
        </div>
      </div>

      {loading ? <div className={styles.note}>Loading chart…</div> : null}
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : null}

      {chunks && !error && groups.length === 0 ? (
        <div className={styles.note} data-testid="chart-empty">
          No parsed sections for this patient.
        </div>
      ) : null}

      {chunks && !error && groups.length > 0
        ? groups.map((g) =>
            raw ? <RawSection key={g.section} group={g} /> : <ParsedSection key={g.section} group={g} />,
          )
        : null}
    </div>
  )
}
