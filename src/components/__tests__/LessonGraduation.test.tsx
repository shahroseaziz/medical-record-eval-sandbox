import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LessonBeat3 } from '../LessonBeat3'
import { LessonGraduation } from '../LessonGraduation'

/**
 * Acceptance test for SHA-64 R12 — graduation wiring:
 *  1. finishing Beat 3 reveals a clear "you did it" win-moment (not always-on),
 *  2. the graduation CTA routes into the bench (not a restart),
 *  3. the learner's state (rubric + labels) is carried in the bench href.
 */
describe('Lesson graduation (R12)', () => {
  it('the win-moment is gated — it appears only after the learner finishes', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    expect(screen.queryByTestId('lesson-graduation')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('beat3-finish-btn'))
    expect(screen.getByTestId('lesson-graduation')).toBeInTheDocument()
    expect(screen.getByTestId('lesson-graduation')).toHaveTextContent('You did it')
  })

  it('the CTA routes into the workbench, not a restart of the lesson', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    fireEvent.click(screen.getByTestId('beat3-finish-btn'))
    const cta = screen.getByTestId('graduation-cta') as HTMLAnchorElement
    const href = cta.getAttribute('href') ?? ''
    expect(href.startsWith('/workbench?')).toBe(true)
    expect(href).not.toContain('/lesson')
  })

  it('carries the learner’s rubric and labels into the bench href', () => {
    render(<LessonBeat3 initialThreshold={0.85} />)
    // Switch to the lenient rubric and relabel a case before finishing.
    fireEvent.click(screen.getByTestId('beat3-rubric-lenient'))
    fireEvent.click(screen.getByTestId('set-intent-fail-beat3-medications-pass'))

    fireEvent.click(screen.getByTestId('beat3-finish-btn'))
    const href = (screen.getByTestId('graduation-cta') as HTMLAnchorElement).getAttribute('href') ?? ''
    expect(href).toContain('rubric=lenient')
    expect(href).toContain('evaluator=faithfulness')
    expect(decodeURIComponent(href)).toContain('beat3-medications-pass:fail')
  })

  it('recaps the learner’s own run — rubric and you⇄judge agreement', () => {
    render(
      <LessonGraduation
        rubric="strict"
        labels={{ 'beat3-medications-pass': 'fail' }}
        threshold={0.85}
      />,
    )
    expect(screen.getByTestId('graduation-rubric')).toHaveTextContent('strict')
    expect(screen.getByTestId('graduation-relabeled')).toHaveTextContent('1')
    // Agreement renders as "k/n (p%)" — a concrete, deterministic recap.
    expect(screen.getByTestId('graduation-agreement').textContent).toMatch(/\d\/\d \(\d+%\)/)
  })
})
