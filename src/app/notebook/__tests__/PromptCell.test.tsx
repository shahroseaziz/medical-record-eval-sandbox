import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { PromptCell, FREE_TIER_PATIENT_CAP } from '../PromptCell'
import { WORKED_PROMPT } from '../worked-example'
import type { NotebookPatient } from '../types'

function makePatients(n: number): NotebookPatient[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Patient ${i}`,
    record: `record-${i}`,
    recordTokens: 100,
    age: 40 + i,
    sex: 'F',
    conditionCount: i,
  }))
}

/** Thin harness so chip add/remove (which lifts state) is exercised for real. */
function Harness({
  patients,
  hasKey,
  onRun = () => {},
  initialPrompt = '',
}: {
  patients: NotebookPatient[]
  hasKey: boolean
  onRun?: () => void
  initialPrompt?: string
}) {
  const [prompt, setPrompt] = useState(initialPrompt)
  const [selected, setSelected] = useState<string[]>(patients.length ? [patients[0].id] : [])
  return (
    <PromptCell
      prompt={prompt}
      setPrompt={setPrompt}
      patients={patients}
      selected={selected}
      setSelected={setSelected}
      lockedId={patients.length ? patients[0].id : null}
      hasKey={hasKey}
      running={false}
      onRun={onRun}
      showLoadExample={prompt.trim().length === 0}
      loadError={null}
    />
  )
}

describe('PromptCell (N8a)', () => {
  it('has a single user-prompt textarea with the worked example as placeholder (no system prompt)', () => {
    render(<Harness patients={makePatients(3)} hasKey={false} />)
    const inputs = screen.getAllByRole('textbox')
    expect(inputs).toHaveLength(1) // ONE prompt, deliberately no system-prompt editor
    expect(screen.getByTestId('prompt-input')).toHaveAttribute('placeholder', WORKED_PROMPT)
  })

  it('starts with exactly one pre-selected, locked chip', () => {
    render(<Harness patients={makePatients(3)} hasKey={false} />)
    const chips = screen.getAllByTestId('run-chip')
    expect(chips).toHaveLength(1)
    expect(within(chips[0]).getByText('pre-selected')).toBeInTheDocument()
    // the locked chip exposes no remove control
    expect(within(chips[0]).queryByTestId('run-chip-remove')).not.toBeInTheDocument()
  })

  it('the "+" picker adds another patient', async () => {
    const user = userEvent.setup()
    render(<Harness patients={makePatients(3)} hasKey={false} />)
    await user.click(screen.getByTestId('add-patient'))
    const rows = screen.getAllByTestId('add-patient-row')
    await user.click(rows[0])
    expect(screen.getAllByTestId('run-chip')).toHaveLength(2)
  })

  it('caps the free tier at FREE_TIER_PATIENT_CAP patients', async () => {
    const user = userEvent.setup()
    render(<Harness patients={makePatients(8)} hasKey={false} />)
    // add until full (start at 1 pre-selected)
    for (let i = 1; i < FREE_TIER_PATIENT_CAP; i++) {
      await user.click(screen.getByTestId('add-patient'))
      await user.click(screen.getAllByTestId('add-patient-row')[0])
    }
    expect(screen.getAllByTestId('run-chip')).toHaveLength(FREE_TIER_PATIENT_CAP)
    const add = screen.getByTestId('add-patient')
    expect(add).toBeDisabled()
    expect(add).toHaveTextContent(`${FREE_TIER_PATIENT_CAP} max · free tier`)
  })

  it('a stored key lifts the free-tier cap', async () => {
    const user = userEvent.setup()
    render(<Harness patients={makePatients(8)} hasKey={true} />)
    // add past the free-tier cap — the key removes it
    for (let i = 1; i <= FREE_TIER_PATIENT_CAP; i++) {
      await user.click(screen.getByTestId('add-patient'))
      await user.click(screen.getAllByTestId('add-patient-row')[0])
    }
    expect(screen.getAllByTestId('run-chip')).toHaveLength(FREE_TIER_PATIENT_CAP + 1)
    expect(screen.getByTestId('add-patient')).not.toBeDisabled()
  })

  it('shows the metered-call count before Run (free tier)', () => {
    render(<Harness patients={makePatients(3)} hasKey={false} />)
    const preview = screen.getByTestId('cost-preview')
    expect(preview).toHaveTextContent('1 metered call')
    expect(preview).toHaveTextContent(/free tier/i)
  })

  it('frames BYO calls as billed to your key (not metered)', () => {
    render(<Harness patients={makePatients(3)} hasKey={true} />)
    expect(screen.getByTestId('cost-preview')).toHaveTextContent(/billed to your key/i)
  })

  it('load-the-worked-example fills the prompt', async () => {
    const user = userEvent.setup()
    render(<Harness patients={makePatients(3)} hasKey={false} />)
    await user.click(screen.getByTestId('load-example'))
    expect(screen.getByTestId('prompt-input')).toHaveValue(WORKED_PROMPT)
  })

  it('disables Run with an empty prompt', async () => {
    const onRun = vi.fn()
    render(<Harness patients={makePatients(3)} hasKey={false} onRun={onRun} />)
    expect(screen.getByTestId('run-button')).toBeDisabled()
  })
})
