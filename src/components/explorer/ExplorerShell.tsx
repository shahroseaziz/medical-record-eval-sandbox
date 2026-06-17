'use client'

/*
 * ExplorerShell (N7a) — host layout that owns the Explore-the-data drawer's open
 * state and composes it with the notebook WITHOUT ever unmounting the notebook.
 *
 * Key property (acceptance): the notebook (`children`) is rendered unconditionally
 * and its parent element is structurally identical whether the drawer is open or
 * closed — only a className flips. The drawer is a fixed-position overlay sibling,
 * so React never tears down and rebuilds the notebook subtree on open/close, and
 * in-progress prompt text / notebook state survive the cycle. The notebook is
 * merely PADDED to make room for the slide-over.
 *
 * The selected-patient state is the defined stub target for N7b (per-patient chart
 * detail + raw-XML toggle): a row click records the patient here; N7b renders the
 * detail off it.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ExplorerDrawer } from './ExplorerDrawer'
import type { ExplorerPatient } from './types'
import styles from './ExplorerShell.module.css'

interface ExplorerContextValue {
  isOpen: boolean
  open: () => void
  close: () => void
  toggle: () => void
  /** Last row-clicked patient — N7b detail target. Null until a row is clicked. */
  selectedPatient: ExplorerPatient | null
}

const ExplorerContext = createContext<ExplorerContextValue | null>(null)

/** Hook for descendants (e.g. the notebook's "Explore the data" button) to drive the drawer. */
export function useExplorer(): ExplorerContextValue {
  const ctx = useContext(ExplorerContext)
  if (!ctx) throw new Error('useExplorer must be used within <ExplorerShell>')
  return ctx
}

export interface ExplorerShellProps {
  children: ReactNode
  /** Render the built-in "Explore the data" trigger button. Default true. */
  showTrigger?: boolean
  /** Test seam: override the drawer's fetch endpoint. */
  endpoint?: string
}

export function ExplorerShell({ children, showTrigger = true, endpoint }: ExplorerShellProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedPatient, setSelectedPatient] = useState<ExplorerPatient | null>(null)

  const open = useCallback(() => setIsOpen(true), [])
  const close = useCallback(() => setIsOpen(false), [])
  const toggle = useCallback(() => setIsOpen((v) => !v), [])

  // N7b stub target: record the row-clicked patient. N7b swaps this for the chart
  // detail + raw-XML view; for now selecting a row simply parks the patient here.
  const handleSelectPatient = useCallback((patient: ExplorerPatient) => {
    setSelectedPatient(patient)
  }, [])

  const ctx = useMemo<ExplorerContextValue>(
    () => ({ isOpen, open, close, toggle, selectedPatient }),
    [isOpen, open, close, toggle, selectedPatient],
  )

  return (
    <ExplorerContext.Provider value={ctx}>
      <div className={`${styles.shell} ${isOpen ? styles.drawerOpen : ''}`}>
        {/* The notebook host: rendered ALWAYS, never keyed on `isOpen`, only padded. */}
        <div className={styles.notebook} data-testid="explorer-notebook">
          {showTrigger ? (
            <div className={styles.triggerBar}>
              <button
                type="button"
                className={`${styles.trigger} ${isOpen ? styles.triggerOn : ''}`}
                onClick={toggle}
                aria-expanded={isOpen}
                data-testid="explore-trigger"
              >
                Explore the data
              </button>
            </div>
          ) : null}
          {children}
        </div>

        <ExplorerDrawer
          open={isOpen}
          onClose={close}
          onSelectPatient={handleSelectPatient}
          endpoint={endpoint}
        />
      </div>
    </ExplorerContext.Provider>
  )
}
