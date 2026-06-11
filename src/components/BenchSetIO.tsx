'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Card, Stack, Text } from '@/components/ui'
import {
  type BenchSet,
  exportBenchSet,
  importBenchSet,
  BenchSetValidationError,
  BenchQuotaExceededError,
  scanLegacyCases,
  migrateLegacyToV4,
  exportLegacyCases,
  setCompletion,
  type LegacyScan,
} from '@/lib/cases'

// Trigger a browser download of a JSON string under the given filename.
function downloadJson(json: string, filename: string) {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

interface Props {
  /** The set currently in view — the export target. Null disables export. */
  set: BenchSet | null
  /** Called after a successful import with the validated set, so the host can persist + select it. */
  onImport: (set: BenchSet) => void
  /** Called after the D5 legacy migration runs, so the host can refresh its list. */
  onMigrated?: () => void
}

// S21 JSON export/import UI — "S16's blob finally gets its button". Export is
// prompted at set-completion moments (design #9); import validates against the v4
// schema and surfaces NAMED errors (never a silent partial state). Also hosts the
// D5 legacy-store migration banner (non-destructive; legacy keys never deleted).
export function BenchSetIO({ set, onImport, onMigrated }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [legacy, setLegacy] = useState<LegacyScan | null>(null)
  const [dismissedPrompt, setDismissedPrompt] = useState(false)

  useEffect(() => {
    setLegacy(scanLegacyCases())
  }, [])

  // A completed set is an export-prompt moment (design #9) — surfaced once until
  // dismissed or the set changes.
  const completion = set ? setCompletion(set) : null
  const showExportPrompt = completion?.complete === true && !dismissedPrompt

  function handleExport() {
    if (!set) return
    const filename = `${set.name.replace(/[^a-z0-9-_]+/gi, '_') || 'benchset'}.json`
    downloadJson(exportBenchSet(set), filename)
    setDismissedPrompt(true)
  }

  // D5 escape hatch — save the pre-v4 data BEFORE migrating.
  function handleExportLegacy() {
    downloadJson(exportLegacyCases(), 'legacy-cases.json')
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    setError(null)
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const imported = importBenchSet(String(reader.result ?? ''))
        // onImport persists via the store, which enforces the pre-flight quota
        // gate — a full store throws BenchQuotaExceededError, surfaced (named) here
        // rather than escaping the reader callback unhandled.
        onImport(imported)
      } catch (err) {
        // Named, human-readable error — the malformed field (or quota) is in the message.
        setError(
          err instanceof BenchSetValidationError || err instanceof BenchQuotaExceededError
            ? err.message
            : `Import failed: ${(err as Error).message}`,
        )
      }
    }
    reader.onerror = () => setError('Import failed: could not read the file.')
    reader.readAsText(file)
    // Allow re-selecting the same file after fixing it.
    e.target.value = ''
  }

  function handleMigrate() {
    setError(null)
    try {
      migrateLegacyToV4()
    } catch (err) {
      // A full store throws BenchQuotaExceededError from saveBenchStore — surface
      // it (named) instead of letting it escape the click handler unhandled. The
      // legacy keys are untouched, so the user can still Export legacy JSON.
      setError(
        err instanceof BenchQuotaExceededError
          ? err.message
          : `Migration failed: ${(err as Error).message}`,
      )
      return
    }
    setLegacy(scanLegacyCases())
    onMigrated?.()
  }

  return (
    <Stack gap={2} data-testid="benchset-io">
      {/* D5 — legacy-store migration banner (non-destructive). */}
      {legacy && !legacy.done && legacy.total > 0 && (
        <Card tone="info" padding="sm" data-testid="legacy-migration-banner">
          <Stack gap={1}>
            <Text size="sm">
              Found <strong>{legacy.total}</strong> case{legacy.total === 1 ? '' : 's'} from earlier
              versions ({legacy.v1Count} from My Cases, {legacy.v3Count} from the golden-set
              builder). Import them into a “Migrated” set? Your existing data is left untouched.
            </Text>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <Button size="sm" onClick={handleMigrate} data-testid="legacy-migrate-btn">
                Import {legacy.total} legacy case{legacy.total === 1 ? '' : 's'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={handleExportLegacy}
                data-testid="legacy-export-btn"
              >
                Export legacy JSON
              </Button>
            </div>
          </Stack>
        </Card>
      )}

      {/* design #9 — export prompted at a set-completion moment. */}
      {showExportPrompt && (
        <Card tone="success" padding="sm" data-testid="export-prompt">
          <Stack gap={1}>
            <Text size="sm">
              This set is fully scored. Export it now so your work is safe — local storage is
              cleared if you reset the browser, unless you export.
            </Text>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <Button size="sm" onClick={handleExport} data-testid="export-prompt-btn">
                Export “{set?.name}”
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDismissedPrompt(true)}
                data-testid="export-prompt-dismiss"
              >
                Later
              </Button>
            </div>
          </Stack>
        </Card>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleExport}
          disabled={!set}
          data-testid="export-btn"
        >
          Export set (JSON)
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => fileRef.current?.click()}
          data-testid="import-btn"
        >
          Import set (JSON)
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
          style={{ display: 'none' }}
          data-testid="import-file-input"
        />
      </div>

      {error && (
        <Card tone="danger" padding="sm" data-testid="import-error">
          <Text size="sm">{error}</Text>
        </Card>
      )}
    </Stack>
  )
}
