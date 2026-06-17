import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScoreLine } from '../ScoreLine'
import {
  createEmptyState,
  safeImportState,
  SCHEMA_VERSION,
  type NotebookEval,
  type NotebookRun,
  type NotebookState,
  type ScoreRow,
} from '@/lib/notebook/state'

// SHA-163 N11 → SHA-170 N15a — the score area is a PROJECTION of the N4 cube.
// At 1×1 (one eval, one scored run) it stays the simple TRAIL (unchanged); any
// larger shape (>1 run OR >1 eval) expands into the runs×evals GRID. The grid is
// numbers only here — markers/disputed (N15b) and navigation (N15c) come later.
// Export remains the WHOLE cube + meta, round-tripped through the import gate.

function mkRun(id: string, version: number): NotebookRun {
  return {
    id,
    version,
    promptText: 'p' + version,
    promptHash: 'h' + version,
    createdAt: `2026-06-1${version}T00:00:00.000Z`,
    outputs: {
      'patient-a': {
        text: 'out',
        model: 'claude-opus-4-8',
        contextMode: 'full',
        sections: ['medications'],
        status: 'ok',
      },
    },
  }
}

function mkRow(n: number): ScoreRow {
  return { frac: `${n}/1`, per: [{ patientId: 'patient-a', pass: n === 1, fails: [] }] }
}

function mkEval(key: string, label: string, version: number): NotebookEval {
  return {
    key,
    label,
    version,
    criteriaOrGolden: '{}',
    history: Array.from({ length: version }, (_, i) => ({
      version: i + 1,
      contentHash: `h${i + 1}`,
    })),
  }
}

/** A single eval scored on a single run — the 1×1 simple-trail case. */
function oneByOneState(): NotebookState {
  return {
    ...createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' }),
    runs: [mkRun('run-1', 1)],
    evals: [mkEval('golden', 'Golden set', 1)],
    scores: { golden: { 'run-1': mkRow(1) } },
  }
}

/** A golden eval scored across four runs (so the grid columns cap at the last 3). */
function fourRunState(): NotebookState {
  return {
    ...createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' }),
    runs: [mkRun('run-1', 1), mkRun('run-2', 2), mkRun('run-3', 3), mkRun('run-4', 4)],
    evals: [mkEval('golden', 'Golden set', 1)],
    scores: {
      golden: {
        'run-1': mkRow(0),
        'run-2': mkRow(1),
        'run-3': mkRow(0),
        'run-4': mkRow(1),
      },
    },
  }
}

describe('ScoreLine (SHA-163 N11 / SHA-170 N15a)', () => {
  beforeEach(() => {
    // jsdom lacks the object-URL + download plumbing the export uses.
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:mock'),
      revokeObjectURL: vi.fn(),
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing-yet copy when no eval is scored', () => {
    render(<ScoreLine state={createEmptyState()} />)
    expect(screen.getByTestId('section-score')).toBeInTheDocument()
    expect(screen.queryByTestId('score-trail')).not.toBeInTheDocument()
    expect(screen.queryByTestId('score-grid')).not.toBeInTheDocument()
    // Export only appears once there is a cube to export.
    expect(screen.queryByTestId('score-export')).not.toBeInTheDocument()
  })

  it('1×1 (one eval, one scored run) stays the simple trail — no grid', () => {
    render(<ScoreLine state={oneByOneState()} />)
    expect(screen.queryByTestId('score-grid')).not.toBeInTheDocument()

    const trail = screen.getByTestId('score-trail')
    expect(trail).toHaveAttribute('data-eval-key', 'golden')
    const fracs = within(trail).getAllByTestId('trail-frac')
    expect(fracs).toHaveLength(1)
    expect(fracs[0].textContent).toBe('1/1')
    expect(fracs[0].getAttribute('data-run-id')).toBe('run-1')
    expect(fracs[0].getAttribute('data-current')).toBe('true')
  })

  it('expands to the grid when >1 scored run (single eval): cols=runs, current highlighted', () => {
    render(<ScoreLine state={fourRunState()} />)
    // The 1×1 trail is gone — this is the grid now.
    expect(screen.queryByTestId('score-trail')).not.toBeInTheDocument()
    expect(screen.getByTestId('score-grid')).toBeInTheDocument()

    // Columns = scored runs, last 3 by default (run-1 dropped), in run order.
    const cols = screen.getAllByTestId('grid-col')
    expect(cols.map((c) => c.getAttribute('data-run-id'))).toEqual(['run-2', 'run-3', 'run-4'])
    // Only the most recent (current) run column is highlighted.
    expect(cols.map((c) => c.getAttribute('data-current'))).toEqual(['false', 'false', 'true'])
    expect(within(cols[2]).getByText('current')).toBeInTheDocument()

    // One eval row, cells are the fracs across the visible columns.
    const rows = screen.getAllByTestId('grid-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-eval-key', 'golden')
    const cells = screen.getAllByTestId('grid-cell')
    expect(cells.map((c) => c.textContent)).toEqual(['1/1', '0/1', '1/1'])
    expect(cells.map((c) => c.getAttribute('data-run-id'))).toEqual(['run-2', 'run-3', 'run-4'])
  })

  it('"all runs" expander toggles between last 3 and every scored run', async () => {
    const user = userEvent.setup()
    render(<ScoreLine state={fourRunState()} />)

    const expander = screen.getByTestId('grid-expander')
    expect(expander).toHaveTextContent('all runs (4)')
    expect(screen.getAllByTestId('grid-col')).toHaveLength(3)

    await user.click(expander)
    expect(expander).toHaveTextContent('last 3 runs')
    const cols = screen.getAllByTestId('grid-col')
    expect(cols.map((c) => c.getAttribute('data-run-id'))).toEqual([
      'run-1',
      'run-2',
      'run-3',
      'run-4',
    ])

    await user.click(expander)
    expect(screen.getAllByTestId('grid-col')).toHaveLength(3)
  })

  it('expands to the grid when >1 eval (single run): rows=evals, stamped with state versions', () => {
    const state: NotebookState = {
      ...createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' }),
      runs: [mkRun('run-1', 1)],
      evals: [mkEval('golden', 'Golden set', 1), mkEval('judge:j1', 'My judge', 3)],
      scores: {
        golden: { 'run-1': mkRow(1) },
        'judge:j1': { 'run-1': mkRow(0) },
      },
    }
    render(<ScoreLine state={state} />)
    expect(screen.queryByTestId('score-trail')).not.toBeInTheDocument()

    const rows = screen.getAllByTestId('grid-row')
    expect(rows.map((r) => r.getAttribute('data-eval-key'))).toEqual(['golden', 'judge:j1'])
    // Row labels carry the version stamp read from state.evals (N16 versions).
    expect(rows.map((r) => r.getAttribute('data-version'))).toEqual(['1', '3'])
    // v1 is not stamped visibly; a revised eval shows its "vN" badge.
    expect(within(rows[0]).queryByText(/^v\d+$/)).not.toBeInTheDocument()
    expect(within(rows[1]).getByText('v3')).toBeInTheDocument()

    // Only one run column, and it is the current run.
    const cols = screen.getAllByTestId('grid-col')
    expect(cols).toHaveLength(1)
    expect(cols[0]).toHaveAttribute('data-current', 'true')
  })

  it('renders "—" for an (eval, run) pair that was never scored', () => {
    const state: NotebookState = {
      ...createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' }),
      runs: [mkRun('run-1', 1), mkRun('run-2', 2)],
      evals: [mkEval('golden', 'Golden set', 1), mkEval('judge:j1', 'My judge', 1)],
      scores: {
        golden: { 'run-1': mkRow(1), 'run-2': mkRow(0) },
        // judge only scored on run-2 → its run-1 cell is a gap.
        'judge:j1': { 'run-2': mkRow(1) },
      },
    }
    render(<ScoreLine state={state} />)
    const judgeRow = screen
      .getAllByTestId('grid-cell')
      .filter((c) => c.getAttribute('data-eval-key') === 'judge:j1')
    expect(judgeRow.map((c) => c.textContent)).toEqual(['—', '1/1'])
  })

  it('has NO disputed-cell indicator or trust markers (arrive in N15b)', () => {
    render(<ScoreLine state={fourRunState()} />)
    expect(screen.queryByTestId('disputed-cell')).not.toBeInTheDocument()
    expect(screen.getByTestId('score-grid').textContent).not.toMatch(/disput/i)
  })

  it('Export serializes the WHOLE cube + meta, round-tripping the import validator', async () => {
    const user = userEvent.setup()
    // Capture the JSON the export writes into the Blob (jsdom's Blob has no
    // readable .text()), so we can feed it back through the validator.
    let capturedJson = ''
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts: unknown[]) {
          capturedJson = (parts as string[]).join('')
        }
      },
    )

    const state = fourRunState()
    render(<ScoreLine state={state} />)
    await user.click(screen.getByTestId('score-export'))

    expect(capturedJson).not.toBe('')

    // Round-trips through the N4 validator → it is the full, schema-valid cube.
    const result = safeImportState(capturedJson)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.state).toEqual(state)
      // Not a lossy on-screen subset: every run column + meta survives.
      expect(result.state.schemaVersion).toBe(SCHEMA_VERSION)
      expect(result.state.runs).toHaveLength(4)
      expect(Object.keys(result.state.scores.golden)).toEqual([
        'run-1',
        'run-2',
        'run-3',
        'run-4',
      ])
      expect(result.state.meta).toEqual({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' })
    }
  })
})
