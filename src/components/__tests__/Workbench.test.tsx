import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Workbench } from '../Workbench'

const ALLERGIES = 'beat3-allergies-rubric-sensitive-fail'

/**
 * Acceptance test for SHA-63 R11 — the open workbench:
 *  1. lands pre-loaded with results,
 *  2. changing a knob (rubric, evaluator, label) re-runs,
 *  3. faithfulness reshapes the surface (no expected column),
 *  4. the red-cell aha reproduces (allergies flips strict→lenient),
 *  5. the prompt knob is live (regenerate calls the run API).
 */
describe('Workbench (open workbench)', () => {
  it('lands pre-loaded with results — the faithfulness surface is populated on first paint', () => {
    render(<Workbench />)
    expect(screen.getByTestId('workbench')).toBeInTheDocument()
    expect(screen.getByTestId('disagreement-table')).toBeInTheDocument()
    // Every pre-loaded case has a row.
    expect(screen.getByTestId(`disagreement-row-${ALLERGIES}`)).toBeInTheDocument()
  })

  it('the red-cell aha reproduces: the allergies case flips agree → disagree on the rubric knob', () => {
    render(<Workbench />)
    // Default strict rubric: the allergies case agrees with its designed-fail label.
    expect(screen.getByTestId(`disagreement-row-${ALLERGIES}`)).toHaveAttribute(
      'data-disagrees',
      'false',
    )
    // Flip the rubric to lenient → the judge is fooled, so it disagrees (the red cell).
    fireEvent.click(screen.getByTestId('rubric-lenient'))
    expect(screen.getByTestId(`disagreement-row-${ALLERGIES}`)).toHaveAttribute(
      'data-disagrees',
      'true',
    )
  })

  it('faithfulness reshapes the surface: no expected column; the other evaluators add one', () => {
    render(<Workbench />)
    // Faithfulness (default): no expected column header.
    expect(screen.queryByTestId('expected-column-header')).not.toBeInTheDocument()
    expect(screen.getByTestId('results-panel')).toHaveAttribute('data-evaluator', 'faithfulness')

    // Switch to reference-judge → an expected column appears, faithfulness table gone.
    fireEvent.click(screen.getByTestId('evaluator-option-reference-judge'))
    expect(screen.getByTestId('expected-column-header')).toHaveTextContent('Expected')
    expect(screen.queryByTestId('disagreement-table')).not.toBeInTheDocument()

    // Switch to structured-diff → still an expected column (the answer key).
    fireEvent.click(screen.getByTestId('evaluator-option-structured-diff'))
    expect(screen.getByTestId('expected-column-header')).toBeInTheDocument()

    // Back to faithfulness → the expected column disappears again.
    fireEvent.click(screen.getByTestId('evaluator-option-faithfulness'))
    expect(screen.queryByTestId('expected-column-header')).not.toBeInTheDocument()
  })

  it('the rubric knob only shows for faithfulness (the only evaluator it affects)', () => {
    render(<Workbench />)
    expect(screen.getByTestId('rubric-knob')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('evaluator-option-reference-judge'))
    expect(screen.queryByTestId('rubric-knob')).not.toBeInTheDocument()
  })

  it('the record inspector shows the selected case grounding', () => {
    render(<Workbench />)
    expect(screen.getByTestId('record-inspector')).toBeInTheDocument()
    // Selecting a case updates the inspected grounding.
    fireEvent.click(screen.getByTestId(`case-select-${ALLERGIES}`))
    const inspector = screen.getByTestId('record-inspector')
    expect(inspector).toHaveTextContent('Penicillin')
  })

  it('flipping an intent label re-runs agreement', () => {
    render(<Workbench />)
    // The clean medications pass agrees by default.
    const medsRow = 'disagreement-row-beat3-medications-pass'
    expect(screen.getByTestId(medsRow)).toHaveAttribute('data-disagrees', 'false')
    // Flip its label to fail → now the judge (PASS) disagrees with the label.
    fireEvent.click(screen.getByTestId('set-intent-fail-beat3-medications-pass'))
    expect(screen.getByTestId(medsRow)).toHaveAttribute('data-disagrees', 'true')
  })

  it('the prompt knob is live: editing it surfaces a stale note and a regenerate control', () => {
    render(<Workbench />)
    const editor = screen.getByTestId('generation-prompt-input') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'Be extremely terse. One word answers only.' } })
    expect(screen.getByTestId('prompt-stale-note')).toBeInTheDocument()
    expect(screen.getByTestId('regenerate-btn')).toBeEnabled()
  })

  // ── R12: carried-over state from the lesson graduation seeds the knobs ──────
  it('seeds the rubric and labels from the lesson carry-over (not a cold default)', () => {
    render(
      <Workbench
        initialRubric="lenient"
        initialLabelOverrides={{ 'beat3-medications-pass': 'fail' }}
      />,
    )
    // The lenient rubric is pre-selected → the allergies red cell already disagrees.
    expect(screen.getByTestId('rubric-lenient')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId(`disagreement-row-${ALLERGIES}`)).toHaveAttribute(
      'data-disagrees',
      'true',
    )
    // The carried label override is applied on first paint (meds now disagrees).
    expect(screen.getByTestId('disagreement-row-beat3-medications-pass')).toHaveAttribute(
      'data-disagrees',
      'true',
    )
  })
})
