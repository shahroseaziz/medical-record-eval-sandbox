'use client'

import { useCallback, useEffect, useState } from 'react'
import { BYO_MODEL, GENERATION_MODEL, modelDisplayName } from '@/lib/models'
import styles from './notebook.module.css'

/**
 * Notebook shell (SHA-156 N6) — the single-scroll sandbox surface: header
 * (wordmark · BYO-key slot · always-visible model identity), the data strip
 * (realism line + Explore button), and the empty section scaffolding (prompt →
 * output → eval → score) that later steps fill. Ships ALONGSIDE the existing
 * routes; cutover to `/` is N18.
 *
 * MODEL + CAPS (decided 2026-06-17 — a 2-state free/BYO toggle, NOT a picker):
 *   - No stored key  → ACTIVE model is GENERATION_MODEL (free tier), caps ON
 *     (shared limit, ≤5 patients per run).
 *   - A stored key   → ACTIVE model is BYO_MODEL (your key), caps LIFTED.
 * The model label is derived from the pinned id via `modelDisplayName` — never a
 * literal here — so it cannot drift from `lib/models.ts` (the single id source).
 */

/** The free tier's shared per-run patient ceiling. */
const FREE_TIER_PATIENT_CAP = 5

/**
 * sessionStorage key for the bring-your-own API key. Session-scoped and never
 * persisted to disk or sent to a server in this step — the key is held only for
 * the active tab so the shell can reflect the free/BYO toggle. Treated as a
 * secret: never logged.
 */
const BYO_KEY_STORAGE = 'mres.nb.byokey'

export function NotebookShell({ patientCount }: { patientCount: number | null }) {
  // The BYO key. Initialised empty for a deterministic first render (no SSR/CSR
  // mismatch); hydrated from sessionStorage on mount.
  const [apiKey, setApiKey] = useState('')
  const [keyOpen, setKeyOpen] = useState(false)
  // The Explore button's stub target — the real drawer lands in N7a. Wired to
  // real state here so the control is live, not dead.
  const [exploreOpen, setExploreOpen] = useState(false)

  useEffect(() => {
    try {
      const stored = window.sessionStorage.getItem(BYO_KEY_STORAGE)
      if (stored) setApiKey(stored)
    } catch {
      // sessionStorage can throw in locked-down contexts — fall back to in-memory.
    }
  }, [])

  const onKeyChange = useCallback((value: string) => {
    setApiKey(value)
    try {
      if (value.trim()) window.sessionStorage.setItem(BYO_KEY_STORAGE, value)
      else window.sessionStorage.removeItem(BYO_KEY_STORAGE)
    } catch {
      // ignore — in-memory state still reflects the toggle.
    }
  }, [])

  const hasKey = apiKey.trim().length > 0
  // The two derived facts every downstream cell reads from this step:
  const activeModel = hasKey ? BYO_MODEL : GENERATION_MODEL
  const capsActive = !hasKey
  const tierLabel = hasKey ? 'your key' : 'free tier'

  return (
    <div className={styles.app}>
      <header className={styles.appbar} data-testid="notebook-header">
        <div className={styles.brand}>
          <span className={styles.mark} data-testid="notebook-wordmark">
            M<span className={styles.dot} aria-hidden="true" />RES
          </span>
          <span className={styles.brandSub}>Medical-Record Eval Sandbox</span>
        </div>

        <div className={styles.appbarRight}>
          {/* Always-visible model identity — derived from lib/models.ts, truthful
              about the ACTIVE model. */}
          <span
            className={styles.modelBadge}
            data-testid="model-label"
            data-active-model={activeModel}
            data-caps-active={capsActive ? 'true' : 'false'}
          >
            <span className={styles.led} aria-hidden="true" />
            {modelDisplayName(activeModel)} · {tierLabel}
          </span>

          <div className={styles.apiKey}>
            <button
              type="button"
              className={styles.apiKeyBtn}
              data-testid="byo-key-toggle"
              aria-expanded={keyOpen}
              onClick={() => setKeyOpen((o) => !o)}
            >
              <span
                className={`${styles.keyDot} ${hasKey ? styles.keyDotOn : ''}`}
                aria-hidden="true"
              />
              {hasKey ? 'Your key' : 'Free tier'}
            </button>

            {keyOpen && (
              <div className={styles.apiKeyPop} data-testid="byo-key-popover">
                <div className={styles.akpTitle}>API key</div>
                <p className={styles.akpSub}>
                  Free tier runs {modelDisplayName(GENERATION_MODEL)} on a shared limit, up to{' '}
                  {FREE_TIER_PATIENT_CAP} patients. Your own key switches to{' '}
                  {modelDisplayName(BYO_MODEL)} and removes both caps.
                </p>
                <input
                  className={styles.akpInput}
                  data-testid="byo-key-input"
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="sk-ant-… (optional)"
                  aria-label="Anthropic API key"
                  value={apiKey}
                  onChange={(e) => onKeyChange(e.target.value)}
                />
                <div className={styles.akpFoot} data-testid="byo-key-foot">
                  {hasKey
                    ? `Key kept in this tab only · ${modelDisplayName(BYO_MODEL)}`
                    : `Using free tier · ${modelDisplayName(GENERATION_MODEL)}`}
                </div>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={styles.notebook}>
        <div className={styles.nbInner}>
          {/* ── Data strip ─────────────────────────────────────────────── */}
          <div className={styles.dataStrip} data-testid="data-strip">
            <p className={styles.dsLine} data-testid="realism-line">
              {patientCount != null ? (
                <>
                  <span className={styles.dsN}>{patientCount}</span> synthetic patient charts ·
                  Synthea C-CDA · fully synthetic, no real PHI.
                </>
              ) : (
                <>Synthetic patient charts · Synthea C-CDA · fully synthetic, no real PHI.</>
              )}
            </p>
            <div className={styles.dsRow2}>
              <span className={styles.dsNote}>
                Synthetic charts are cleaner than real ones — a prompt that works here still meets
                messier records in production.
              </span>
              <button
                type="button"
                className={`${styles.exploreBtn} ${exploreOpen ? styles.exploreOn : ''}`}
                data-testid="explore-button"
                aria-expanded={exploreOpen}
                aria-controls="data-explorer-stub"
                onClick={() => setExploreOpen(true)}
              >
                Explore the data
              </button>
            </div>
          </div>

          {/* Stub target for the Explore button. The real slide-over drawer lands
              in N7a; until then this keeps the control live (not dead) and marks
              the mount point. */}
          {exploreOpen && (
            <aside
              id="data-explorer-stub"
              className={styles.exploreStub}
              data-testid="data-explorer-stub"
              role="region"
              aria-label="Data explorer"
            >
              <span>Data explorer opens here — arriving in a later step.</span>
              <button
                type="button"
                className={styles.exploreStubClose}
                data-testid="data-explorer-stub-close"
                onClick={() => setExploreOpen(false)}
              >
                Close
              </button>
            </aside>
          )}

          {/* ── Section scaffolding (document order; later steps fill these) ── */}
          <section
            className={styles.cell}
            data-testid="section-prompt"
            aria-label="Prompt"
          >
            <span className={styles.cellLabel}>Prompt</span>
            <p className={styles.cellPlaceholder}>
              Write a prompt against one synthetic chart. Arrives in a later step.
            </p>
          </section>

          <section
            className={styles.cell}
            data-testid="section-output"
            aria-label="Model output"
          >
            <span className={styles.cellLabel}>Model output</span>
            <p className={styles.cellPlaceholder}>
              The model&apos;s answer, with a receipt of what it saw. Arrives in a later step.
            </p>
          </section>

          <section className={styles.cell} data-testid="section-eval" aria-label="Eval">
            <span className={styles.cellLabel}>Eval</span>
            <p className={styles.cellPlaceholder}>
              A golden answer, then a judge, to check the output. Arrives in a later step.
            </p>
          </section>

          <section className={styles.cell} data-testid="section-score" aria-label="Score">
            <span className={styles.cellLabel}>Score</span>
            <p className={styles.cellPlaceholder}>
              The score line for this run. Arrives in a later step.
            </p>
          </section>

          <div className={styles.nbEnd} aria-hidden="true" />
        </div>
      </main>
    </div>
  )
}
