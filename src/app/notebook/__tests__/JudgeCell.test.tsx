import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { JudgeCell } from '../JudgeCell'
import type { OutputCardResult } from '../useNotebookRun'
import type { NotebookPatient } from '../types'

// SHA-167 N14 — an ADDED judge cell: its own criteria box, its own judge loop, a
// remove control, a cube key of its own (`judge:<id>`), and a per-cell cost
// preview. The golden set never multiplies — only judges do.

function patient(id: string, name: string): NotebookPatient {
  return { id, name, record: '', recordTokens: 0, age: 60, sex: 'F', conditionCount: 3 }
}
function done(id: string, output: string): OutputCardResult {
  return { patientId: id, status: 'done', output, model: 'claude-haiku-4-5-20251001', context: null }
}

function stubScore(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
  let i = 0
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 503), json: async () => r.body } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderCell(opts?: {
  evalKey?: string
  label?: string
  hasKey?: boolean
  onScoreReport?: (r: unknown) => void
  onRemove?: () => void
}) {
  const order = ['p1', 'p2']
  const results: Record<string, OutputCardResult> = {
    p1: done('p1', '{"a1c_current": 6.7}'),
    p2: done('p2', '{"a1c_current": 7.1}'),
  }
  const patientsById = new Map<string, NotebookPatient>([
    ['p1', patient('p1', 'Ada Lovelace')],
    ['p2', patient('p2', 'Alan Turing')],
  ])
  const onRemove = opts?.onRemove ?? vi.fn()
  const onScoreReport = opts?.onScoreReport ?? vi.fn()
  render(
    <JudgeCell
      evalKey={opts?.evalKey ?? 'judge:j2'}
      label={opts?.label ?? 'LLM judge 2'}
      order={order}
      results={results}
      patientsById={patientsById}
      hasKey={opts?.hasKey ?? false}
      onScoreReport={onScoreReport}
      onRemove={onRemove}
    />,
  )
  return { onRemove, onScoreReport }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('JudgeCell — an added, removable judge', () => {
  it('renders its label, a criteria box, a Run judge button, and a Remove control', () => {
    renderCell({ label: 'LLM judge 2' })
    expect(screen.getByTestId('judge-cell')).toHaveAttribute('data-eval-key', 'judge:j2')
    expect(screen.getByLabelText('LLM judge 2')).toBeInTheDocument()
    expect(screen.getByTestId('judge-cell-criteria')).toBeInTheDocument()
    expect(screen.getByTestId('judge-cell-run')).toBeInTheDocument()
    expect(screen.getByTestId('judge-cell-remove')).toBeInTheDocument()
  })

  it('Remove fires onRemove (the shell drops the cell + cleans its scores)', async () => {
    const user = userEvent.setup()
    const { onRemove } = renderCell()
    await user.click(screen.getByTestId('judge-cell-remove'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('shows a per-cell cost preview of one judge over the gradeable patients', () => {
    renderCell()
    // Two patients with output → one judge × 2 patients = 2 calls.
    expect(screen.getByTestId('judge-cell-cost')).toHaveTextContent('1 judge × 2 patients = 2 calls')
  })

  it('makes EXACTLY one metered call per patient and reports its row under its OWN eval key', async () => {
    const fetchMock = stubScore([
      { ok: true, body: { pass: true, reason: 'Matches.' } },
      { ok: true, body: { pass: false, reason: 'Stale A1c.' } },
    ])
    const onScoreReport = vi.fn()
    const user = userEvent.setup()
    renderCell({ evalKey: 'judge:j2', label: 'LLM judge 2', onScoreReport })

    await user.click(screen.getByTestId('judge-cell-criteria'))
    await user.paste('Pass if the A1c is current.')
    await user.click(screen.getByTestId('judge-cell-run'))

    await waitFor(() => expect(screen.getAllByTestId('judge-verdict')).toHaveLength(2))

    // One criteria call per patient.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('/api/score')
    }

    // The lifted row is keyed by THIS judge — not judge:default.
    await waitFor(() => expect(onScoreReport).toHaveBeenCalled())
    const last = onScoreReport.mock.calls.at(-1)![0]
    expect(last.evalKey).toBe('judge:j2')
    expect(last.label).toBe('LLM judge 2')
    expect(last.row.frac).toBe('1/2')
  })
})
