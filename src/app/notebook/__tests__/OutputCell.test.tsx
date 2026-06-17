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
      p1: { patientId: 'p1', status: 'streaming', output: '{ partial', model: null, context: null },
    })
    const card = screen.getByTestId('output-card')
    expect(within(card).getByText('Ada Lovelace')).toBeInTheDocument()
    expect(within(card).getByTestId('streaming-flag')).toBeInTheDocument()
    expect(card).toHaveTextContent('{ partial')
  })

  it('stamps the model id that travelled back in the response (done state)', () => {
    renderCell({
      p1: { patientId: 'p1', status: 'done', output: '{"ok":true}', model: GENERATION_MODEL, context: null },
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
      { p1: { patientId: 'p1', status: 'done', output: 'x', model: GENERATION_MODEL, context: null } },
      onViewChart,
    )
    await user.click(screen.getByTestId('view-chart'))
    expect(onViewChart).toHaveBeenCalledWith('p1')
  })

  it('renders an error state when a card failed', () => {
    renderCell({
      p1: { patientId: 'p1', status: 'error', output: '', model: null, context: null, error: 'limit reached' },
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

// ── "What the model saw" receipt (N8b) ───────────────────────────────────────
// The receipt is driven entirely by the `type:'context'` manifest captured into
// result.context — no live run is needed. A SMALL patient (chart fit) emits a FULL
// manifest; a LARGE patient (chart over budget) emits a RETRIEVED manifest with
// dropped sections. Both are exercised here from the part alone.

describe('OutputCell — what-the-model-saw receipt (N8b)', () => {
  const fullResult: OutputCardResult = {
    patientId: 'p1',
    status: 'done',
    output: '{"ok":true}',
    model: GENERATION_MODEL,
    context: { contextMode: 'full', sections: [{ section: 'record', chars: 4200 }] },
  }

  const retrievedResult: OutputCardResult = {
    patientId: 'p1',
    status: 'done',
    output: '{"ok":true}',
    model: GENERATION_MODEL,
    context: {
      contextMode: 'retrieved',
      sections: [
        { section: 'medications', chars: 21 },
        { section: 'problems', chars: 64 },
      ],
      droppedSections: ['labs', 'imaging'],
    },
  }

  it('renders the FULL manifest honestly for a small patient (chart fit in context)', async () => {
    const user = userEvent.setup()
    renderCell({ p1: fullResult })
    await user.click(screen.getByTestId('what-model-saw'))

    const receipt = screen.getByTestId('context-receipt')
    expect(receipt).toHaveAttribute('data-context-mode', 'full')
    expect(screen.getByTestId('context-mode-label')).toHaveTextContent('full chart · fit in context')
    // Renders the section the model saw — and only that.
    const sections = within(receipt).getAllByTestId('context-section')
    expect(sections).toHaveLength(1)
    expect(sections[0]).toHaveTextContent('record')
    expect(sections[0]).toHaveTextContent('4,200 chars')
    // No retrieved-mode copy, no dropped-sections block.
    expect(receipt).not.toHaveTextContent('chart too large')
    expect(within(receipt).queryByTestId('context-dropped')).not.toBeInTheDocument()
  })

  it('renders the RETRIEVED manifest honestly for a large patient (chart too large + dropped sections)', async () => {
    const user = userEvent.setup()
    renderCell({ p1: retrievedResult })
    await user.click(screen.getByTestId('what-model-saw'))

    const receipt = screen.getByTestId('context-receipt')
    expect(receipt).toHaveAttribute('data-context-mode', 'retrieved')
    expect(screen.getByTestId('context-mode-label')).toHaveTextContent(
      'retrieved sections · chart too large',
    )
    // Lists exactly the retrieved sections.
    const sections = within(receipt).getAllByTestId('context-section')
    expect(sections.map((s) => s.textContent)).toEqual([
      expect.stringContaining('medications'),
      expect.stringContaining('problems'),
    ])
    // Honestly names what the budget dropped.
    const dropped = within(receipt).getByTestId('context-dropped')
    expect(dropped).toHaveTextContent('labs')
    expect(dropped).toHaveTextContent('imaging')
  })

  it('is collapsed by default and toggles open/closed', async () => {
    const user = userEvent.setup()
    renderCell({ p1: fullResult })
    expect(screen.queryByTestId('context-receipt')).not.toBeInTheDocument()
    const toggle = screen.getByTestId('what-model-saw')
    await user.click(toggle)
    expect(screen.getByTestId('context-receipt')).toBeInTheDocument()
    await user.click(toggle)
    expect(screen.queryByTestId('context-receipt')).not.toBeInTheDocument()
  })

  it('offers no receipt toggle when no context manifest arrived', () => {
    renderCell({
      p1: { patientId: 'p1', status: 'done', output: 'x', model: GENERATION_MODEL, context: null },
    })
    expect(screen.queryByTestId('what-model-saw')).not.toBeInTheDocument()
  })
})
