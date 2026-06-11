'use client'

import type { BenchStructuredRow } from '@/lib/cases'
import { emptyStructuredRow, incompleteStructuredRows } from '@/lib/workbench/composer'
import styles from './CaseComposer.module.css'

interface Props {
  rows: BenchStructuredRow[]
  onChange: (rows: BenchStructuredRow[]) => void
}

const COLUMNS: Array<{ key: keyof BenchStructuredRow; label: string; required: boolean }> = [
  { key: 'drug', label: 'drug', required: true },
  { key: 'dose', label: 'dose', required: true },
  { key: 'route', label: 'route', required: false },
  { key: 'status', label: 'status', required: false },
]

/**
 * The med-family field builder (S24 / D10). Each row is a structured expectation —
 * drug / dose / route / status — matching the design/reference prototype's per-field
 * authoring. `drug` + `dose` are required (D10); the scorer (structured-diff) reads
 * `drug` as the name and `dose` as the dose, so a completed row is directly
 * answer-keyable (the R4 contract — see composer.ts `scoreStructuredAgainstRows`).
 *
 * Other structured clinical shapes are out of scope this cycle — they author as
 * prose / reference-judge instead (D10).
 */
export function FieldBuilder({ rows, onChange }: Props) {
  const incomplete = new Set(incompleteStructuredRows(rows))

  function updateCell(i: number, key: keyof BenchStructuredRow, value: string) {
    onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)))
  }
  function addRow() {
    onChange([...rows, emptyStructuredRow()])
  }
  function removeRow(i: number) {
    onChange(rows.filter((_, j) => j !== i))
  }

  return (
    <div className={styles.fieldBuilder} data-testid="field-builder">
      <div className={styles.fbHeaderRow} aria-hidden>
        {COLUMNS.map((c) => (
          <span key={c.key} className={styles.fbColHead}>
            {c.label}
            {c.required && <span className={styles.fbReq}> *</span>}
          </span>
        ))}
        <span />
      </div>

      {rows.length === 0 && (
        <p className={styles.fbEmpty}>No rows yet — add the medications the answer expects.</p>
      )}

      {rows.map((row, i) => (
        <div
          key={i}
          className={`${styles.fbRow} ${incomplete.has(i) ? styles.fbRowIncomplete : ''}`}
          data-testid={`field-row-${i}`}
          data-incomplete={incomplete.has(i) ? 'true' : 'false'}
        >
          {COLUMNS.map((c) => (
            <input
              key={c.key}
              className={styles.fbInput}
              data-testid={`field-row-${i}-${c.key}`}
              placeholder={c.label}
              aria-label={`row ${i + 1} ${c.label}`}
              value={row[c.key]}
              onChange={(e) => updateCell(i, c.key, e.target.value)}
            />
          ))}
          <button
            type="button"
            className={styles.fbRemove}
            data-testid={`field-row-${i}-remove`}
            aria-label={`remove row ${i + 1}`}
            onClick={() => removeRow(i)}
          >
            ×
          </button>
        </div>
      ))}

      <button type="button" className={styles.fbAddRow} data-testid="field-add-row" onClick={addRow}>
        + Add medication row
      </button>

      {incomplete.size > 0 && (
        <p className={styles.fbHint} data-testid="field-builder-incomplete">
          Each row needs a <strong>drug</strong> and a <strong>dose</strong> before it can be saved
          (route and status are optional).
        </p>
      )}
    </div>
  )
}
