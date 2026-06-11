'use client'

import { useMemo, useState } from 'react'
import { formatCcdaDate } from '@/lib/ccda/format-date'
import type { BenchCaseV4, BenchFieldScorer, BenchStructuredRow } from '@/lib/cases'
import {
  KNOWN_SECTIONS,
  filterBySections,
  deriveScorer,
  EXPECTED_FIELD_KEY,
  incompleteStructuredRows,
  cleanStructuredRows,
  addCaseToAuthoredSet,
  draftToCase,
  type ExpectedKind,
} from '@/lib/workbench/composer'
import { FieldBuilder } from './FieldBuilder'
import styles from './CaseComposer.module.css'

interface Demographics {
  firstName?: string
  lastName?: string
  gender?: string
  birthDate?: string
}
interface PatientSummary {
  demographics?: Demographics
  sections: string[]
}
interface SampledPatient {
  id: string
  name: string
  summary: PatientSummary
  record: string
  recordTokens: number
}
interface SampleResponse {
  patients?: SampledPatient[]
  requested?: number
  returned?: number
  shortfall?: boolean
  budgetTokens?: number
  error?: string
}

const SCORER_LABEL: Record<BenchFieldScorer, string> = {
  faithfulness: 'Faithfulness',
  'reference-judge': 'Reference judge',
  'structured-diff': 'Structured diff',
}

const KIND_LABEL: Record<ExpectedKind, string> = {
  none: 'None (faithfulness)',
  prose: 'Prose reference',
  structured: 'Field builder',
}

interface Props {
  /** Notified after a case is persisted, so the host can refresh its count. */
  onAdded?: (set: { id: string; cases: BenchCaseV4[] }) => void
}

/**
 * Case composer — the add-case authoring flow (S24). Walks the author through:
 *   patient picker (guarded "give me N random", D3) + section-chip filter (D7) →
 *   record view (clinical dates via the shared C-CDA formatter, SHA-76) → query →
 *   expected output (three-way: prose / field builder D10 / none + absence hint) →
 *   derived scorer chip (E25, override visible) → add to the "My cases" set.
 *
 * The record-size guard runs server-side (/api/patients/sample): the picker only
 * ever offers budget-eligible patients, so every skeleton is authorable, never
 * dead-on-arrival.
 */
export function CaseComposer({ onAdded }: Props) {
  // ── Patient picker ──────────────────────────────────────────────────────────
  const [n, setN] = useState(5)
  const [patients, setPatients] = useState<SampledPatient[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shortfall, setShortfall] = useState<{ returned: number; requested: number } | null>(null)
  const [selectedSections, setSelectedSections] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // ── Authoring ───────────────────────────────────────────────────────────────
  const [taskPrompt, setTaskPrompt] = useState('')
  const [expectedKind, setExpectedKind] = useState<ExpectedKind>('none')
  const [expectedProse, setExpectedProse] = useState('')
  const [structuredRows, setStructuredRows] = useState<BenchStructuredRow[]>([])
  const [scorerOverride, setScorerOverride] = useState<BenchFieldScorer | null>(null)
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const visiblePatients = useMemo(
    () => filterBySections(patients, selectedSections),
    [patients, selectedSections],
  )
  const selected = patients.find((p) => p.id === selectedId) ?? null

  async function fetchPatients() {
    setLoading(true)
    setError(null)
    setShortfall(null)
    try {
      const res = await fetch(`/api/patients/sample?n=${n}`)
      const data = (await res.json()) as SampleResponse
      if (!res.ok || data.error) {
        setError(data.error ?? 'Failed to sample patients')
        return
      }
      const list = data.patients ?? []
      setPatients(list)
      setSelectedId(null)
      if (data.shortfall) {
        setShortfall({ returned: data.returned ?? list.length, requested: data.requested ?? n })
      }
    } catch {
      setError('Network error')
    } finally {
      setLoading(false)
    }
  }

  function toggleSection(s: string) {
    setSelectedSections((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
  }

  function changeKind(kind: ExpectedKind) {
    setExpectedKind(kind)
    setScorerOverride(null) // re-derive from the new kind (E25)
    setSaveError(null)
  }

  // ── E25 derived scorer (+ visible override) ─────────────────────────────────
  const derivedScorer = deriveScorer(expectedKind)
  const activeScorer = scorerOverride ?? derivedScorer
  const fieldKey = EXPECTED_FIELD_KEY[expectedKind]

  // ── Add-to-set gating ───────────────────────────────────────────────────────
  const incompleteRows = incompleteStructuredRows(structuredRows)
  const structuredReady =
    expectedKind !== 'structured' ||
    (cleanStructuredRows(structuredRows).length > 0 && incompleteRows.length === 0)
  const proseReady = expectedKind !== 'prose' || expectedProse.trim() !== ''
  const canAdd = Boolean(selected) && taskPrompt.trim() !== '' && structuredReady && proseReady

  function addCase() {
    if (!selected || !canAdd) return
    setSaveError(null)
    try {
      const authored = draftToCase({
        id:
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? `authored-${crypto.randomUUID().slice(0, 8)}`
            : `authored-${Date.now()}`,
        patientId: selected.id,
        taskPrompt: taskPrompt.trim(),
        ragMode: 'stuff',
        expectedKind,
        expectedProse,
        structuredRows,
        scorerOverride: scorerOverride ?? undefined,
        createdAt: Date.now(),
      })
      const set = addCaseToAuthoredSet(authored)
      setSavedNote(`Added — “${authored.taskPrompt.slice(0, 48)}${authored.taskPrompt.length > 48 ? '…' : ''}” (${set.cases.length} in My cases).`)
      onAdded?.(set)
      // Reset the authored fields for the next case; keep the patient pool.
      setTaskPrompt('')
      setExpectedKind('none')
      setExpectedProse('')
      setStructuredRows([])
      setScorerOverride(null)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not save the case')
    }
  }

  return (
    <div className={styles.composer} data-testid="case-composer">
      {/* ── Step 1 · patient picker (guarded random-N + section chips) ───────── */}
      <section className={styles.step}>
        <header className={styles.stepHeader}>
          <span className={styles.stepEyebrow}>step 1 · patients</span>
          <span className={styles.stepHint}>
            Guarded sample — only patients whose record fits the budget appear.
          </span>
        </header>

        <div className={styles.pickerControls}>
          <label htmlFor="composer-n" className={styles.nLabel}>
            N
          </label>
          <input
            id="composer-n"
            type="number"
            min={1}
            max={20}
            value={n}
            data-testid="composer-n-input"
            className={styles.nInput}
            onChange={(e) => setN(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))}
          />
          <button
            type="button"
            data-testid="give-me-random-btn"
            className={styles.primaryBtn}
            onClick={fetchPatients}
            disabled={loading}
          >
            {loading ? 'Sampling…' : `Give me ${n} random`}
          </button>
        </div>

        {/* D7 — section-chip filter over existing summary.sections metadata. */}
        {patients.length > 0 && (
          <div className={styles.sectionChips} data-testid="section-chips">
            <span className={styles.chipsLabel}>filter by section:</span>
            {KNOWN_SECTIONS.map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`section-chip-${s}`}
                aria-pressed={selectedSections.includes(s)}
                className={`${styles.chip} ${selectedSections.includes(s) ? styles.chipActive : ''}`}
                onClick={() => toggleSection(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {error && (
          <p className={styles.errorNote} data-testid="composer-error">
            {error}
          </p>
        )}
        {shortfall && (
          <p className={styles.warnNote} data-testid="composer-shortfall">
            Only {shortfall.returned} of {shortfall.requested} requested patients fit the budget —
            the rest were excluded by the record-size guard. Try again for a fresh sample.
          </p>
        )}

        {patients.length > 0 && (
          <div className={styles.patientGrid} data-testid="patient-list">
            {visiblePatients.map((p) => {
              const d = p.summary.demographics
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`patient-card-${p.id}`}
                  aria-pressed={selectedId === p.id}
                  className={`${styles.patientCard} ${selectedId === p.id ? styles.patientCardActive : ''}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className={styles.patientName}>
                    {d?.firstName || d?.lastName ? `${d?.firstName ?? ''} ${d?.lastName ?? ''}`.trim() : p.name}
                  </span>
                  <span className={styles.patientMeta}>
                    {d?.birthDate ? `DOB ${formatCcdaDate(d.birthDate)}` : 'DOB —'} ·{' '}
                    {p.recordTokens.toLocaleString()} tok
                  </span>
                  <span className={styles.patientSections}>
                    {p.summary.sections.map((s) => (
                      <span key={s} className={styles.miniChip}>
                        {s}
                      </span>
                    ))}
                  </span>
                </button>
              )
            })}
            {visiblePatients.length === 0 && (
              <p className={styles.warnNote} data-testid="no-patients-after-filter">
                No sampled patient has all of the selected sections. Clear a chip to widen the list.
              </p>
            )}
          </div>
        )}
      </section>

      {/* ── Step 2 · record view (clinical dates via the shared formatter) ───── */}
      {selected && (
        <section className={styles.step} data-testid="record-view">
          <header className={styles.stepHeader}>
            <span className={styles.stepEyebrow}>step 2 · record</span>
            <span className={styles.stepHint}>The source every evaluator checks against.</span>
          </header>
          <div className={styles.recordHead}>
            <strong className={styles.recordName}>
              {selected.summary.demographics?.firstName} {selected.summary.demographics?.lastName}
            </strong>
            <span className={styles.recordDob} data-testid="record-dob">
              DOB {formatCcdaDate(selected.summary.demographics?.birthDate)}
            </span>
          </div>
          <pre className={styles.recordBody} data-testid="record-body">
            {selected.record}
          </pre>
        </section>
      )}

      {/* ── Step 3 · query ──────────────────────────────────────────────────── */}
      {selected && (
        <section className={styles.step} data-testid="query-step">
          <header className={styles.stepHeader}>
            <span className={styles.stepEyebrow}>step 3 · query</span>
            <span className={styles.stepHint}>The task the model is asked to perform.</span>
          </header>
          <textarea
            className={styles.queryInput}
            data-testid="composer-query"
            rows={2}
            placeholder="e.g. List the patient's active medications as { drug, dose, route, status }."
            value={taskPrompt}
            onChange={(e) => setTaskPrompt(e.target.value)}
          />
        </section>
      )}

      {/* ── Step 4 · expected output (three-way) ────────────────────────────── */}
      {selected && (
        <section className={styles.step} data-testid="expected-step">
          <header className={styles.stepHeader}>
            <span className={styles.stepEyebrow}>step 4 · expected output</span>
            <span className={styles.stepHint}>How should this case be graded?</span>
          </header>

          <div className={styles.segmented} role="group" aria-label="Expected output kind">
            {(['none', 'prose', 'structured'] as const).map((k) => (
              <button
                key={k}
                type="button"
                data-testid={`expected-kind-${k}`}
                aria-pressed={expectedKind === k}
                className={`${styles.segment} ${expectedKind === k ? styles.segmentActive : ''}`}
                onClick={() => changeKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>

          {expectedKind === 'none' && (
            <div className={styles.absenceHint} data-testid="absence-hint">
              <strong>No answer key.</strong> The faithfulness judge checks each claim against the
              record — nothing to author up front. For an <em>absence</em> case (&ldquo;the record
              shows no cardiac procedures&rdquo;), switch to <strong>Prose reference</strong> and
              write the absence as the expected answer — a reference judge then grades against it.
            </div>
          )}

          {expectedKind === 'prose' && (
            <textarea
              className={styles.queryInput}
              data-testid="expected-prose"
              rows={3}
              placeholder="e.g. No cardiac procedures are documented. The record shows only a routine physical exam."
              value={expectedProse}
              onChange={(e) => setExpectedProse(e.target.value)}
            />
          )}

          {expectedKind === 'structured' && (
            <FieldBuilder rows={structuredRows} onChange={setStructuredRows} />
          )}

          {/* Derived scorer chip (E25) — derived, with the override visible. */}
          <div className={styles.scorerRow} data-testid="derived-scorer">
            <span className={styles.scorerChip} data-scorer={activeScorer}>
              <span className={styles.scorerField}>{fieldKey}</span>
              <span className={styles.scorerDot}>·</span>
              <span className={styles.scorerName}>{SCORER_LABEL[activeScorer]}</span>
            </span>
            <span className={styles.scorerDerivedNote}>
              {scorerOverride ? 'overridden' : 'derived from your choice'}
            </span>
            <label className={styles.overrideLabel}>
              override:
              <select
                className={styles.overrideSelect}
                data-testid="scorer-override"
                value={activeScorer}
                onChange={(e) =>
                  setScorerOverride(
                    e.target.value === derivedScorer
                      ? null
                      : (e.target.value as BenchFieldScorer),
                  )
                }
              >
                {(['faithfulness', 'reference-judge', 'structured-diff'] as const).map((s) => (
                  <option key={s} value={s}>
                    {SCORER_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
      )}

      {/* ── Add to set ──────────────────────────────────────────────────────── */}
      {selected && (
        <div className={styles.addRow}>
          <button
            type="button"
            data-testid="add-case-btn"
            className={styles.primaryBtn}
            onClick={addCase}
            disabled={!canAdd}
          >
            Add to My cases
          </button>
          {!canAdd && (
            <span className={styles.addHint} data-testid="add-disabled-hint">
              {taskPrompt.trim() === ''
                ? 'Write a query first.'
                : !proseReady
                  ? 'Write the prose reference first.'
                  : !structuredReady
                    ? 'Complete the field-builder rows (drug + dose).'
                    : ''}
            </span>
          )}
          {savedNote && (
            <span className={styles.savedNote} data-testid="composer-saved">
              {savedNote}
            </span>
          )}
          {saveError && (
            <span className={styles.errorNote} data-testid="composer-save-error">
              {saveError}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
