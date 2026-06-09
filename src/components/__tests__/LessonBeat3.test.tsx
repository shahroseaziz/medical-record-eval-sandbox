import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { LessonBeat3 } from '../LessonBeat3'

/**
 * Acceptance test for SHA-62 R10 — the faithfulness capstone:
 *  1. rubric edits move the score,
 *  2. the user labels pass/fail and sees where the judge disagrees with them,
 *  3. the 0.85 threshold is explained (config knob, not magic) with the
 *     small-N honesty line.
 */
describe('LessonBeat3 (faithfulness capstone)', () => {
  it('frames the beat as having no answer key', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    expect(screen.getByTestId('beat3-no-answer-key')).toHaveTextContent('no answer key')
  })

  it('rubric edits move the score: strict 60.4% → lenient 75.0%', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    const score = screen.getByTestId('beat3-mean-score')
    expect(score).toHaveTextContent('60.4%') // strict is the default

    fireEvent.click(screen.getByTestId('beat3-rubric-lenient'))
    expect(screen.getByTestId('beat3-mean-score')).toHaveTextContent('75.0%')
    expect(screen.getByTestId('beat3-active-rubric')).toHaveTextContent('benefit of the doubt')

    fireEvent.click(screen.getByTestId('beat3-rubric-strict'))
    expect(screen.getByTestId('beat3-mean-score')).toHaveTextContent('60.4%')
  })

  it('under the default strict rubric the threshold-sensitive case is the disagreement', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    const row = screen.getByTestId('disagreement-row-beat3-problems-threshold-sensitive-pass')
    expect(row).toHaveAttribute('data-disagrees', 'true')
    // the clean pass agrees
    expect(screen.getByTestId('disagreement-row-beat3-medications-pass')).toHaveAttribute(
      'data-disagrees',
      'false',
    )
  })

  it('switching to the lenient rubric moves the disagreement to the aspirin hallucination', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    fireEvent.click(screen.getByTestId('beat3-rubric-lenient'))
    expect(
      screen.getByTestId('disagreement-row-beat3-allergies-rubric-sensitive-fail'),
    ).toHaveAttribute('data-disagrees', 'true')
    expect(
      screen.getByTestId('disagreement-row-beat3-problems-threshold-sensitive-pass'),
    ).toHaveAttribute('data-disagrees', 'false')
  })

  it('the user can relabel a case and the judge disagreement updates', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    const medRow = screen.getByTestId('disagreement-row-beat3-medications-pass')
    // designed-pass + judge pass → no disagreement
    expect(medRow).toHaveAttribute('data-disagrees', 'false')

    // Flip the learner's label to designed-fail: now it contradicts the judge.
    fireEvent.click(screen.getByTestId('set-intent-fail-beat3-medications-pass'))
    expect(screen.getByTestId('disagreement-row-beat3-medications-pass')).toHaveAttribute(
      'data-disagrees',
      'true',
    )
  })

  it('explains the threshold as a config knob with the not-validation-at-small-N line', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    const explainer = screen.getByTestId('beat3-threshold-explainer')
    expect(within(explainer).getByTestId('beat3-threshold-value')).toHaveTextContent('0.85')
    expect(explainer).toHaveTextContent('evals/thresholds.yaml')
    expect(explainer).toHaveTextContent('not validation')
    expect(explainer).toHaveTextContent('sample size')
  })

  it('surfaces the grounding as the judge’s only source (no answer key)', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    expect(screen.getByTestId('beat3-grounding')).toHaveTextContent('no answer key')
    expect(
      screen.getByTestId('beat3-grounding-beat3-allergies-rubric-sensitive-fail'),
    ).toHaveTextContent('Penicillin')
  })
})
