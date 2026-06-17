'use client'

import { useState } from 'react'
import type { NotebookPatient } from './types'
import { WORKED_PROMPT } from './worked-example'
import styles from './notebook.module.css'

/**
 * Prompt cell (SHA-159 N8a) — the single user-prompt editor plus the "Run
 * against" patient chips and the Run control.
 *
 * There is deliberately NO system-prompt editor: the notebook has ONE prompt.
 * The textarea's placeholder is the worked example; a first-timer can load it
 * verbatim. Chips start with one pre-selected (locked) patient; a "+" picker adds
 * more, capped at FREE_TIER_PATIENT_CAP on the free tier and uncapped once a BYO
 * key is stored. A cost-preview line states the metered-call count a Run costs
 * BEFORE the user commits.
 */

/** The free tier's shared per-run patient ceiling; lifted by a stored BYO key. */
export const FREE_TIER_PATIENT_CAP = 5

interface ChipProps {
  patient: NotebookPatient
  locked: boolean
  onRemove: () => void
}

/** One selected-patient chip with light framing; the pre-selected one is locked. */
function Chip({ patient, locked, onRemove }: ChipProps) {
  const frame = [
    patient.age != null ? `${patient.age}${patient.sex}` : patient.sex,
    `${patient.conditionCount} cond`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <span className={`${styles.chip} ${locked ? styles.chipLocked : ''}`} data-testid="run-chip">
      <span className={styles.chipName}>{patient.name}</span>
      <span className={styles.chipFrame}>{frame}</span>
      {locked ? (
        <span className={styles.chipLock}>pre-selected</span>
      ) : (
        <button
          type="button"
          className={styles.chipX}
          aria-label={`Remove ${patient.name}`}
          data-testid="run-chip-remove"
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </span>
  )
}

interface AddPatientProps {
  available: NotebookPatient[]
  full: boolean
  capped: boolean
  onAdd: (id: string) => void
}

/** The "+" picker. Disabled (and labelled) when the free-tier cap is reached. */
function AddPatient({ available, full, capped, onAdd }: AddPatientProps) {
  const [open, setOpen] = useState(false)
  return (
    <span className={styles.addWrap}>
      <button
        type="button"
        className={styles.addBtn}
        data-testid="add-patient"
        disabled={full || available.length === 0}
        aria-expanded={open}
        title={
          capped
            ? `Free tier runs up to ${FREE_TIER_PATIENT_CAP} patients; your own key removes the cap.`
            : ''
        }
        onClick={() => setOpen((o) => !o)}
      >
        {full ? `${FREE_TIER_PATIENT_CAP} max · free tier` : '+ patient'}
      </button>
      {open && !full && available.length > 0 && (
        <div className={styles.addPop} data-testid="add-patient-pop" role="listbox">
          {available.slice(0, 40).map((p) => (
            <button
              type="button"
              key={p.id}
              className={styles.addRow}
              data-testid="add-patient-row"
              onClick={() => {
                onAdd(p.id)
                setOpen(false)
              }}
            >
              <span className={styles.arName}>{p.name}</span>
              <span className={styles.arMeta}>
                {p.age != null ? `${p.age}${p.sex}` : p.sex} · {p.conditionCount} cond
              </span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

export interface PromptCellProps {
  prompt: string
  setPrompt: (value: string) => void
  patients: NotebookPatient[]
  selected: string[]
  setSelected: (ids: string[]) => void
  /** The pre-selected patient id — its chip is locked (cannot be removed). */
  lockedId: string | null
  /** A stored BYO key lifts the free-tier patient cap. */
  hasKey: boolean
  running: boolean
  onRun: () => void
  /** Show the "Load the worked example" affordance (prompt is empty / untouched). */
  showLoadExample: boolean
  loadError: string | null
}

export function PromptCell({
  prompt,
  setPrompt,
  patients,
  selected,
  setSelected,
  lockedId,
  hasKey,
  running,
  onRun,
  showLoadExample,
  loadError,
}: PromptCellProps) {
  const byId = new Map(patients.map((p) => [p.id, p]))
  const cap = hasKey ? Infinity : FREE_TIER_PATIENT_CAP
  const full = selected.length >= cap
  const available = patients.filter((p) => !selected.includes(p.id))

  const n = selected.length
  // Cost preview: the metered-call count a Run will cost, stated BEFORE Run. A
  // free-tier call draws the shared meter; a BYO call bills the caller's own key
  // and is not metered against the shared free tier — be honest about both.
  const costLine = hasKey
    ? `The prompt runs once per selected patient · ${n} ${n === 1 ? 'call' : 'calls'} billed to your key (not metered)`
    : `The prompt runs once per selected patient · ${n} metered ${n === 1 ? 'call' : 'calls'} against the free tier`

  return (
    <section className={styles.cell} data-testid="section-prompt" aria-label="Prompt">
      <span className={styles.cellLabel}>Prompt</span>

      {showLoadExample && (
        <div className={styles.loadExample}>
          <span className={styles.leText}>New here? </span>
          <button
            type="button"
            className={styles.leLink}
            data-testid="load-example"
            onClick={() => setPrompt(WORKED_PROMPT)}
          >
            Load the worked example →
          </button>
        </div>
      )}

      <textarea
        className={styles.promptIn}
        data-testid="prompt-input"
        value={prompt}
        spellCheck={false}
        placeholder={WORKED_PROMPT}
        aria-label="Prompt"
        onChange={(e) => setPrompt(e.target.value)}
      />

      <div className={styles.runAgainst}>
        <div className={styles.raLeft}>
          <span className={styles.raLabel}>Run against</span>
          <div className={styles.chips} data-testid="run-chips">
            {selected.map((id) => {
              const p = byId.get(id)
              if (!p) return null
              return (
                <Chip
                  key={id}
                  patient={p}
                  locked={id === lockedId}
                  onRemove={() => setSelected(selected.filter((x) => x !== id))}
                />
              )
            })}
            <AddPatient
              available={available}
              full={full}
              capped={full && !hasKey}
              onAdd={(id) => setSelected([...selected, id])}
            />
          </div>
        </div>
        <button
          type="button"
          className={styles.runBtn}
          data-testid="run-button"
          disabled={running || selected.length === 0 || prompt.trim().length === 0}
          onClick={onRun}
        >
          {running ? 'Running…' : 'Run'}
        </button>
      </div>

      <div className={styles.runNote} data-testid="cost-preview">
        {costLine}
      </div>

      {loadError && (
        <div className={styles.loadError} data-testid="patients-load-error" role="alert">
          {loadError}
        </div>
      )}
    </section>
  )
}
