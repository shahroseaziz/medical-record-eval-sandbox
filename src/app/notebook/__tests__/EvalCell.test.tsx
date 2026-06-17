import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EvalCell } from '../EvalCell'
import type { OutputCardResult } from '../useNotebookRun'
import type { NotebookPatient } from '../types'

// SHA-161 N9 — golden-answer eval cell. No-chooser invite → per-patient golden
// editors → CLIENT-SIDE deterministic scoring via lib/eval/normalize. The final
// test asserts ZERO network calls fire while scoring (collateral guard).

function patient(id: string, name: string): NotebookPatient {
  return { id, name, record: '', recordTokens: 0, age: 60, sex: 'F', conditionCount: 3 }
}

function doneResult(id: string, output: string): OutputCardResult {
  return { patientId: id, status: 'done', output, model: 'claude-haiku-4-5-20251001' }
}

const MODEL_OUT = JSON.stringify({
  a1c_current: 6.7,
  a1c_trend: 'improving',
  diabetes_meds: ['Metformin', 'Glipizide'],
})

function renderCell(opts?: { order?: string[]; results?: Record<string, OutputCardResult> }) {
  const order = opts?.order ?? ['p1', 'p2']
  const results =
    opts?.results ??
    ({ p1: doneResult('p1', MODEL_OUT), p2: doneResult('p2', MODEL_OUT) } as Record<
      string,
      OutputCardResult
    >)
  const patientsById = new Map<string, NotebookPatient>([
    ['p1', patient('p1', 'Ada Lovelace')],
    ['p2', patient('p2', 'Alan Turing')],
  ])
  const onViewChart = vi.fn()
  render(
    <EvalCell
      order={order}
      results={results}
      patientsById={patientsById}
      onViewChart={onViewChart}
    />,
  )
  return { onViewChart }
}

describe('EvalCell — invite (no chooser)', () => {
  it('offers a primary "Add golden answers" and a quieter "or use an LLM judge" link — no radio/chooser', () => {
    renderCell()
    const invite = screen.getByTestId('eval-invite')
    expect(within(invite).getByTestId('golden-invite-add')).toHaveTextContent(/add golden answers/i)
    expect(within(invite).getByTestId('golden-invite-judge')).toHaveTextContent(/llm judge/i)
    // No-chooser: there is no radio group in the invite.
    expect(invite.querySelector('input[type="radio"]')).toBeNull()
  })

  it('stays quiet (no invite) until there is model output to grade', () => {
    renderCell({ order: [], results: {} })
    expect(screen.queryByTestId('eval-invite')).not.toBeInTheDocument()
    expect(screen.getByTestId('section-eval')).toBeInTheDocument()
  })

  it('the judge link reveals a live, defined stub (judge path is N10)', async () => {
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-judge'))
    expect(screen.getByTestId('judge-stub')).toBeInTheDocument()
  })
})

describe('EvalCell — golden editors', () => {
  it('shows a per-patient editor with an open-chart link and the chart-not-output nudge', async () => {
    const user = userEvent.setup()
    const { onViewChart } = renderCell()
    await user.click(screen.getByTestId('golden-invite-add'))

    const editors = screen.getAllByTestId('golden-editor')
    expect(editors).toHaveLength(2)
    expect(editors[0]).toHaveAttribute('data-patient-id', 'p1')
    expect(within(editors[0]).getByText('Ada Lovelace')).toBeInTheDocument()

    // The "grade the chart, not the output" nudge is present.
    expect(screen.getByTestId('golden-nudge')).toHaveTextContent(/grade the chart, not the output/i)

    // The open-chart link is live (beside the editor).
    await user.click(within(editors[0]).getByTestId('golden-open-chart'))
    expect(onViewChart).toHaveBeenCalledWith('p1')
  })

  it('passes a patient when every golden field matches after normalization', async () => {
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-add'))

    // A golden with a SIG alias + reordered list — both folded by normalize.ts.
    const golden = JSON.stringify({
      a1c_trend: 'improving',
      diabetes_meds: ['Glipizide', 'Metformin'],
    })
    const inputs = screen.getAllByTestId('golden-input')
    await user.click(inputs[0])
    await user.paste(golden)
    await user.click(screen.getByTestId('golden-score'))

    const editor = screen.getAllByTestId('golden-editor')[0]
    expect(within(editor).getByTestId('golden-verdict')).toHaveAttribute('data-verdict', 'pass')
  })

  it('a failing field shows a ≠ chip that expands to an expected-vs-got diff', async () => {
    const user = userEvent.setup()
    renderCell({ order: ['p1'], results: { p1: doneResult('p1', MODEL_OUT) } })
    await user.click(screen.getByTestId('golden-invite-add'))

    await user.click(screen.getByTestId('golden-input'))
    await user.paste(JSON.stringify({ a1c_current: 5.9 }))
    await user.click(screen.getByTestId('golden-score'))

    const chip = screen.getByTestId('golden-fail-chip')
    expect(chip).toHaveTextContent('a1c_current')
    expect(screen.queryByTestId('golden-diff')).not.toBeInTheDocument()

    await user.click(chip)
    const diff = screen.getByTestId('golden-diff')
    expect(diff).toHaveTextContent('5.9') // expected (golden)
    expect(diff).toHaveTextContent('6.7') // got (model)
  })

  it('grades partially — a field absent from the golden is not graded', async () => {
    const user = userEvent.setup()
    renderCell({ order: ['p1'], results: { p1: doneResult('p1', MODEL_OUT) } })
    await user.click(screen.getByTestId('golden-invite-add'))

    // Only asserts a1c_current (correct); the rest of the output is ungraded.
    await user.click(screen.getByTestId('golden-input'))
    await user.paste(JSON.stringify({ a1c_current: 6.7 }))
    await user.click(screen.getByTestId('golden-score'))

    expect(screen.getByTestId('golden-verdict')).toHaveAttribute('data-verdict', 'pass')
    expect(screen.getByTestId('golden-overall')).toHaveTextContent('1/1')
  })
})

describe('EvalCell — ZERO metered calls during scoring (collateral guard)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scoring a golden fires no network / score call — it is purely client-side', async () => {
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-add'))

    const inputs = screen.getAllByTestId('golden-input')
    await user.click(inputs[0])
    await user.paste(JSON.stringify({ a1c_current: 6.7 }))
    await user.click(screen.getByTestId('golden-score'))

    // The verdict rendered (proof scoring ran) …
    expect(screen.getByTestId('golden-overall')).toBeInTheDocument()
    // … and not a single fetch was made.
    expect(fetch).not.toHaveBeenCalled()
  })
})
