import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OutputCell } from '../OutputCell'
import type { OutputCardResult } from '../useNotebookRun'
import type { NotebookPatient } from '../types'
import { GENERATION_MODEL, modelDisplayName } from '@/lib/models'

const PATIENTS: NotebookPatient[] = [
  { id: 'p1', name: 'Ada Lovelace', record: 'r1', recordTokens: 10, age: 36, sex: 'F', conditionCount: 2 },
]
const byId = new Map(PATIENTS.map((p) => [p.id, p]))

function renderCell(results: Record<string, OutputCardResult>, onViewChart = () => {}) {
  return render(
    <OutputCell
      order={Object.keys(results)}
      results={results}
      patientsById={byId}
      onViewChart={onViewChart}
    />,
  )
}

describe('OutputCell (N8a)', () => {
  it('renders one card per patient with a streaming flag while streaming', () => {
    renderCell({
      p1: { patientId: 'p1', status: 'streaming', output: '{ partial', model: null },
    })
    const card = screen.getByTestId('output-card')
    expect(within(card).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(card).getByTestId('streaming-flag')).toBeInTheDocument()
    expect(card).toHaveTextContent('{ partial')
  })

  it('stamps the model id that travelled back in the response (done state)', () => {
    renderCell({
      p1: { patientId: 'p1', status: 'done', output: '{"ok":true}', model: GENERATION_MODEL },
    })
    const stamp = screen.getByTestId('model-stamp')
    // The stamp is the response model id, formatted — not a literal in the component.
    expect(stamp).toHaveAttribute('data-model-id', GENERATION_MODEL)
    expect(stamp).toHaveTextContent(modelDisplayName(GENERATION_MODEL))
  })

  it('exposes a view-chart link as a defined stub that fires onViewChart', async () => {
    const user = userEvent.setup()
    const onViewChart = vi.fn()
    renderCell(
      { p1: { patientId: 'p1', status: 'done', output: 'x', model: GENERATION_MODEL } },
      onViewChart,
    )
    await user.click(screen.getByTestId('view-chart'))
    expect(onViewChart).toHaveBeenCalledWith('p1')
  })

  it('renders an error state when a card failed', () => {
    renderCell({
      p1: { patientId: 'p1', status: 'error', output: '', model: null, error: 'limit reached' },
    })
    const card = screen.getByTestId('output-card')
    expect(card).toHaveAttribute('data-status', 'error')
    expect(card).toHaveTextContent('limit reached')
  })

  it('shows the placeholder when nothing has run', () => {
    renderCell({})
    expect(screen.getByTestId('section-output')).toHaveTextContent(/Run the prompt/i)
  })
})
