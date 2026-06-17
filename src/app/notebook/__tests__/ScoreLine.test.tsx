import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ScoreLine } from '../ScoreLine'
import {
  createEmptyState,
  safeImportState,
  SCHEMA_VERSION,
  type NotebookRun,
  type NotebookState,
  type ScoreRow,
} from '@/lib/notebook/state'

// SHA-163 N11 — the score line is a PROJECTION of the N4 cube (last 3 scored
// runs of an eval row, prev → current) and Export is the WHOLE cube + meta,
// round-tripped through the import validator — never the trail subset.

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

/** A golden eval scored across four runs (so the trail must cap at the last 3). */
function fourRunState(): NotebookState {
  return {
    ...createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' }),
    runs: [mkRun('run-1', 1), mkRun('run-2', 2), mkRun('run-3', 3), mkRun('run-4', 4)],
    evals: [
      {
        key: 'golden',
        label: 'Golden set',
        version: 1,
        criteriaOrGolden: '{}',
        history: [{ version: 1, contentHash: 'h1' }],
      },
    ],
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

describe('ScoreLine (SHA-163 N11)', () => {
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
    // Export only appears once there is a cube to export.
    expect(screen.queryByTestId('score-export')).not.toBeInTheDocument()
  })

  it('projects the eval-row trail: last 3 scored runs, prev → current', () => {
    render(<ScoreLine state={fourRunState()} />)
    const trail = screen.getByTestId('score-trail')
    expect(trail).toHaveAttribute('data-eval-key', 'golden')

    const fracs = within(trail).getAllByTestId('trail-frac')
    // run-1 dropped (window is the LAST 3); run-2 → run-3 → run-4 in run order.
    expect(fracs.map((f) => f.textContent)).toEqual(['1/1', '0/1', '1/1'])
    expect(fracs.map((f) => f.getAttribute('data-run-id'))).toEqual([
      'run-2',
      'run-3',
      'run-4',
    ])
    // Only the final step is "current".
    expect(fracs.map((f) => f.getAttribute('data-current'))).toEqual(['false', 'false', 'true'])
  })

  it('has NO disputed-cell indicator (arrives with the grid in N15b)', () => {
    render(<ScoreLine state={fourRunState()} />)
    expect(screen.queryByTestId('disputed-cell')).not.toBeInTheDocument()
    expect(screen.queryByTestId('score-trail')?.textContent).not.toMatch(/disput/i)
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
      // Not a lossy trail subset: every run column + meta survives.
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
