'use client'

/*
 * Explore-the-data drawer (N7a) — a fixed-position slide-over holding a sortable
 * table of ALL patients. Visual reference: design/reference/notebook/drawer.jsx.
 *
 * This is a FIXED-POSITION overlay, NOT a flex sibling of the notebook — the
 * flex-sibling "collapse the notebook" layout was tried in design and rejected.
 * Because it is a fixed overlay, it never participates in the notebook's layout
 * and never forces it to remount; the host shell pads the notebook to make room
 * when the drawer is open.
 *
 * Scope here is the shell + table only. A row click calls `onSelectPatient`,
 * the defined stub target the per-patient chart detail + raw-XML toggle (N7b)
 * will hang off of.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AllPatientsResponse, ExplorerPatient } from './types'
import { PatientChartDetail } from './PatientChartDetail'
import styles from './ExplorerDrawer.module.css'

/** The six sortable columns of the patient table. */
type SortKey = 'name' | 'age' | 'sex' | 'conditionCount' | 'medCount' | 'chartBytes'
type SortDir = 'asc' | 'desc'

interface Column {
  key: SortKey
  label: string
  /** Right-aligned numeric columns vs. the left-aligned name column. */
  numeric: boolean
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Patient', numeric: false },
  { key: 'age', label: 'Age', numeric: true },
  { key: 'sex', label: 'Sex', numeric: true },
  { key: 'conditionCount', label: 'Cond', numeric: true },
  { key: 'medCount', label: 'Meds', numeric: true },
  { key: 'chartBytes', label: 'Chart', numeric: true },
]

/** Numeric columns default to descending (largest first) on first click; text ascending. */
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  sex: 'asc',
  age: 'desc',
  conditionCount: 'desc',
  medCount: 'desc',
  chartBytes: 'desc',
}

export interface ExplorerDrawerProps {
  open: boolean
  onClose: () => void
  /**
   * Row-click notification. Still fired (N7a contract) so the host shell can record
   * the selection; N7b ALSO drives the in-drawer chart detail off internal state.
   */
  onSelectPatient?: (patient: ExplorerPatient) => void
  /** Override the fetch endpoint (tests). Production uses `?all=1` — no random/limit. */
  endpoint?: string
  /** Test seam forwarded to the chart detail's chunks fetch. */
  chunksEndpoint?: string
  /**
   * Open the drawer directly onto a specific patient's chart (e.g. an output
   * card's "view chart" link). When this id matches a loaded patient while the
   * drawer is open, that patient's chart detail is shown instead of the table.
   * Null/absent → the drawer opens on the all-patients table.
   */
  focusPatientId?: string | null
}

function formatChartSize(bytes: number): string {
  if (!bytes) return '—'
  const kb = bytes / 1024
  if (kb < 1) return `${bytes} B`
  if (kb < 1000) return `${Math.round(kb)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

function compare(a: ExplorerPatient, b: ExplorerPatient, key: SortKey, dir: SortDir): number {
  const av = a[key]
  const bv = b[key]
  let r: number
  if (typeof av === 'string' || typeof bv === 'string') {
    r = String(av ?? '').localeCompare(String(bv ?? ''))
  } else {
    // null ages sort last regardless of direction-applied below; treat as -Infinity.
    const an = typeof av === 'number' ? av : Number.NEGATIVE_INFINITY
    const bn = typeof bv === 'number' ? bv : Number.NEGATIVE_INFINITY
    r = an - bn
  }
  return dir === 'asc' ? r : -r
}

export function ExplorerDrawer({
  open,
  onClose,
  onSelectPatient,
  endpoint = '/api/patients?all=1',
  chunksEndpoint,
  focusPatientId,
}: ExplorerDrawerProps) {
  const [patients, setPatients] = useState<ExplorerPatient[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  // N7b: the row-clicked patient whose chart detail is shown. Null → the table.
  const [selected, setSelected] = useState<ExplorerPatient | null>(null)
  const fetchedRef = useRef(false)

  // Lazy, once: fetch the full corpus the first time the drawer opens. Keeping the
  // data after close means reopening is instant and never re-hits the endpoint.
  useEffect(() => {
    if (!open || fetchedRef.current) return
    fetchedRef.current = true
    setLoading(true)
    setError(null)
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(endpoint)
        if (!res.ok) throw new Error(`Failed to load patients (${res.status})`)
        const data = (await res.json()) as AllPatientsResponse
        if (!cancelled) setPatients(data.patients ?? [])
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load patients')
          fetchedRef.current = false // allow a retry on next open
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, endpoint])

  // Close on Escape while open. If a chart is open, Escape first backs out to the
  // table; a second Escape closes the drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSelected((cur) => {
        if (cur) return null
        onClose()
        return null
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Reset the selection (and thus the chart's Parsed/Raw toggle, which is keyed by
  // patient id) whenever the drawer closes, so reopening lands on the table.
  useEffect(() => {
    if (!open) setSelected(null)
  }, [open])

  // External focus (e.g. an output card's "view chart" link): when the host asks
  // for a specific patient and the corpus is loaded, open that patient's chart
  // detail rather than the table. Keyed on the request + the loaded list, so a
  // manual "← All patients" back-out is not re-overridden (deps unchanged); every
  // reachable view-chart click toggles `open` closed→open, which re-fires this.
  useEffect(() => {
    if (!open || !focusPatientId || !patients) return
    const match = patients.find((p) => p.id === focusPatientId)
    if (match) setSelected(match)
  }, [open, focusPatientId, patients])

  const handleSelect = useCallback(
    (patient: ExplorerPatient) => {
      setSelected(patient)
      onSelectPatient?.(patient)
    },
    [onSelectPatient],
  )

  const onSort = useCallback((key: SortKey) => {
    setSortKey((prevKey) => {
      setSortDir((prevDir) =>
        prevKey === key ? (prevDir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[key],
      )
      return key
    })
  }, [])

  const sorted = useMemo(() => {
    if (!patients) return []
    return [...patients].sort((a, b) => compare(a, b, sortKey, sortDir))
  }, [patients, sortKey, sortDir])

  return (
    <aside
      id="explorer-drawer"
      className={`${styles.drawer} ${open ? styles.open : ''}`}
      aria-hidden={!open}
      aria-label="Explore the data"
      data-testid="explorer-drawer"
    >
      <div className={styles.top}>
        {selected ? (
          <button
            type="button"
            className={styles.backBtn}
            onClick={() => setSelected(null)}
            data-testid="chart-back"
          >
            ← All patients
          </button>
        ) : (
          <div className={styles.title}>
            Corpus
            {patients ? <span className={styles.count}>{patients.length} patients</span> : null}
          </div>
        )}
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close"
          title="Close"
        >
          ✕
        </button>
      </div>

      <div className={styles.body}>
        {selected ? (
          <PatientChartDetail
            key={selected.id}
            patient={selected}
            endpoint={chunksEndpoint}
          />
        ) : null}

        {!selected && loading ? <div className={styles.note}>Loading corpus…</div> : null}
        {!selected && error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        {!selected && patients && !error ? (
          <table className={styles.table}>
            <thead>
              <tr>
                {COLUMNS.map((col) => {
                  const active = sortKey === col.key
                  return (
                    <th
                      key={col.key}
                      className={col.numeric ? styles.num : undefined}
                      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    >
                      <button
                        type="button"
                        className={styles.sortBtn}
                        onClick={() => onSort(col.key)}
                        data-testid={`sort-${col.key}`}
                      >
                        {col.label}
                        <span className={styles.arrow} aria-hidden="true">
                          {active ? (sortDir === 'asc' ? '▲' : '▼') : ''}
                        </span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr
                  key={p.id}
                  className={styles.row}
                  onClick={() => handleSelect(p)}
                  data-testid={`patient-row-${p.id}`}
                  tabIndex={0}
                  role="button"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handleSelect(p)
                    }
                  }}
                >
                  <td className={styles.nameCell}>{p.name}</td>
                  <td className={styles.num}>{p.age ?? '—'}</td>
                  <td className={styles.num}>{p.sex || '—'}</td>
                  <td className={styles.num}>{p.conditionCount}</td>
                  <td className={styles.num}>{p.medCount}</td>
                  <td className={styles.num}>{formatChartSize(p.chartBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </aside>
  )
}
