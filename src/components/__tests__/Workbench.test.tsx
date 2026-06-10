import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Workbench } from '../Workbench'
import { FALLBACK_THRESHOLDS } from '@/lib/workbench/bench'

const ALLERGIES = 'beat3-allergies-rubric-sensitive-fail'

/**
 * The bench lands as a pipeline (R16) and expands into the dense three-panel daily
 * driver. The two views are mutually exclusive — the panels (and their knobs +
 * results table) are not mounted until the bench is opened. Most assertions below
 * exercise the panels, so this helper renders and expands in one step.
 */
function renderOpen(props: Record<string, unknown> = {}) {
  const utils = render(<Workbench {...props} />)
  fireEvent.click(screen.getByTestId('open-the-bench-btn'))
  return utils
}

/**
 * Acceptance tests:
 *  - R11/R16 open workbench: lands pre-loaded, changing a knob re-runs,
 *    faithfulness reshapes the surface, the red-cell aha reproduces, the prompt
 *    knob is live.
 *  - R16 fidelity: pipeline landing + results badge, open-the-bench expand toggle,
 *    cost strip (free diff vs metered judge), per-field scorer chips.
 */
describe('Workbench (open workbench)', () => {
  // ── R16: the pipeline landing ───────────────────────────────────────────────
  it('lands on the pipeline — three atoms + a live results badge, panels not yet mounted', () => {
    render(<Workbench />)
    expect(screen.getByTestId('workbench')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-pipeline')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-atom-1')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-atom-2')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-atom-3')).toBeInTheDocument()
    // The results badge shows a live number on the landing (open without empty).
    expect(screen.getByTestId('pipeline-results-badge')).toHaveTextContent(/agree/)
    // The dense panels (and their results table) are NOT mounted until opened.
    expect(screen.queryByTestId('results-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('disagreement-table')).not.toBeInTheDocument()
  })

  it('"open the bench" expands the pipeline into the panels; "pipeline view" collapses back', () => {
    render(<Workbench />)
    fireEvent.click(screen.getByTestId('open-the-bench-btn'))
    // Panels (and the results table) mounted; the pipeline landing is gone.
    expect(screen.getByTestId('results-panel')).toBeInTheDocument()
    expect(screen.getByTestId('disagreement-table')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-pipeline')).not.toBeInTheDocument()
    // Collapse back to the pipeline — the panels unmount again.
    fireEvent.click(screen.getByTestId('pipeline-view-btn'))
    expect(screen.getByTestId('workbench-pipeline')).toBeInTheDocument()
    expect(screen.queryByTestId('results-panel')).not.toBeInTheDocument()
  })

  it('clicking an atom node also opens the bench', () => {
    render(<Workbench />)
    fireEvent.click(screen.getByTestId('pipeline-atom-3'))
    expect(screen.getByTestId('results-panel')).toBeInTheDocument()
  })

  it('the pipeline badge summarizes the same agreement the table reports (config threshold, not hardcoded)', () => {
    // A non-default config threshold — the badge must read it, the same cutoff the
    // table classifies against, so the two can never contradict each other.
    render(<Workbench thresholds={{ ...FALLBACK_THRESHOLDS, faithfulness: 0.5 }} />)
    const badge = screen.getByTestId('pipeline-results-badge').textContent ?? ''
    fireEvent.click(screen.getByTestId('open-the-bench-btn'))
    const metric = screen.getByTestId('agreement-value').textContent ?? ''
    const m = metric.match(/(\d+)\/(\d+)/)
    expect(m).not.toBeNull()
    const [, agree, n] = m as RegExpMatchArray
    expect(badge).toContain(`${agree}/${n} agree`)
  })

  // ── R16: atom chrome — cost strip + per-field scorer chips ───────────────────
  it('the results cost strip marks free diff vs metered judge per evaluator', () => {
    renderOpen()
    // Faithfulness is a metered judge.
    expect(screen.getByTestId('cost-strip')).toHaveAttribute('data-metered', 'true')
    // Structured diff is a free, instant diff.
    fireEvent.click(screen.getByTestId('evaluator-option-structured-diff'))
    expect(screen.getByTestId('cost-strip')).toHaveAttribute('data-metered', 'false')
  })

  it('the evaluator panel shows per-field scorer chips that track the active evaluator', () => {
    renderOpen()
    // Faithfulness → a single judged "claims" field.
    expect(screen.getByTestId('per-field-scorers')).toBeInTheDocument()
    expect(screen.getByTestId('field-scorer-claims')).toHaveTextContent('judge')
    // Structured diff → name·diff / dose·diff.
    fireEvent.click(screen.getByTestId('evaluator-option-structured-diff'))
    expect(screen.getByTestId('field-scorer-name')).toHaveTextContent('diff')
    expect(screen.getByTestId('field-scorer-dose')).toHaveTextContent('diff')
  })

  // ── R11: the open bench behaviors (unchanged semantics) ──────────────────────
  it('lands pre-loaded with results — the faithfulness surface is populated when opened', () => {
    renderOpen()
    expect(screen.getByTestId('disagreement-table')).toBeInTheDocument()
    // Every pre-loaded case has a row.
    expect(screen.getByTestId(`disagreement-row-${ALLERGIES}`)).toBeInTheDocument()
  })

  it('the red-cell aha reproduces: the allergies case flips agree → disagree on the rubric knob', () => {
    renderOpen()
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
    renderOpen()
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
    renderOpen()
    expect(screen.getByTestId('rubric-knob')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('evaluator-option-reference-judge'))
    expect(screen.queryByTestId('rubric-knob')).not.toBeInTheDocument()
  })

  it('the record inspector shows the selected case grounding', () => {
    renderOpen()
    expect(screen.getByTestId('record-inspector')).toBeInTheDocument()
    // Selecting a case updates the inspected grounding.
    fireEvent.click(screen.getByTestId(`case-select-${ALLERGIES}`))
    const inspector = screen.getByTestId('record-inspector')
    expect(inspector).toHaveTextContent('Penicillin')
  })

  it('flipping an intent label re-runs agreement', () => {
    renderOpen()
    // The clean medications pass agrees by default.
    const medsRow = 'disagreement-row-beat3-medications-pass'
    expect(screen.getByTestId(medsRow)).toHaveAttribute('data-disagrees', 'false')
    // Flip its label to fail → now the judge (PASS) disagrees with the label.
    fireEvent.click(screen.getByTestId('set-intent-fail-beat3-medications-pass'))
    expect(screen.getByTestId(medsRow)).toHaveAttribute('data-disagrees', 'true')
  })

  it('the prompt knob is live: editing it surfaces a stale note and a regenerate control', () => {
    renderOpen()
    const editor = screen.getByTestId('generation-prompt-input') as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: 'Be extremely terse. One word answers only.' } })
    expect(screen.getByTestId('prompt-stale-note')).toBeInTheDocument()
    expect(screen.getByTestId('regenerate-btn')).toBeEnabled()
  })

  // ── R12: carried-over state from the lesson graduation seeds the knobs ──────
  it('seeds the rubric and labels from the lesson carry-over (not a cold default)', () => {
    renderOpen({
      initialRubric: 'lenient',
      initialLabelOverrides: { 'beat3-medications-pass': 'fail' },
    })
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
