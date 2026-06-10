import { describe, it, expect, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LessonJourney } from '../LessonJourney'
import { LessonBeat2 } from '../LessonBeat2'

/**
 * Acceptance test for SHA-71 R15 — the lesson app shell:
 *  1. a persistent stepper rail (Match → Meaning → Grounding),
 *  2. exactly one beat interactive at a time,
 *  3. advancing is GATED on completing the current beat (Beat 1's run),
 *  4. finished beats collapse to a reopenable summary,
 *  5. graduation stays gated (reached only after stepping through).
 */
describe('LessonJourney (stepper app shell)', () => {
  beforeAll(() => {
    // jsdom has no real scroll; stub it so goTo() is a no-op in tests.
    window.scrollTo = vi.fn()
  })

  it('renders the three-stop journey rail with Match active first', () => {
    render(<LessonJourney initialThreshold={0.85} beat2={<LessonBeat2 />} />)
    expect(screen.getByTestId('lesson-stepper')).toBeInTheDocument()
    expect(screen.getByTestId('lesson-stepper-stop-1')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('lesson-stepper-stop-2')).toHaveAttribute('data-state', 'future')
    expect(screen.getByTestId('lesson-stepper-stop-3')).toHaveAttribute('data-state', 'future')
  })

  it('shows exactly one beat: Beat 1 active, Beats 2 and 3 absent', () => {
    render(<LessonJourney initialThreshold={0.85} beat2={<LessonBeat2 />} />)
    expect(screen.getByTestId('beat-1-active')).toBeInTheDocument()
    expect(screen.getByTestId('lesson-beat-1-interactive')).toBeInTheDocument()
    expect(screen.queryByTestId('lesson-beat-2')).toBeNull()
    expect(screen.queryByTestId('lesson-beat-3')).toBeNull()
  })

  it('gates the advance to Beat 2 behind running the diff', () => {
    render(<LessonJourney initialThreshold={0.85} beat2={<LessonBeat2 />} />)
    // Advance is disabled until Beat 1's diff has run.
    expect(screen.getByTestId('beat-1-advance')).toBeDisabled()

    fireEvent.click(screen.getByTestId('beat1-source-summary'))
    fireEvent.click(screen.getByTestId('beat1-run'))
    expect(screen.getByTestId('beat-1-advance')).toBeEnabled()
  })

  it('advances to Beat 2 and collapses Beat 1 to a reopenable summary', () => {
    render(<LessonJourney initialThreshold={0.85} beat2={<LessonBeat2 />} />)
    fireEvent.click(screen.getByTestId('beat1-source-summary'))
    fireEvent.click(screen.getByTestId('beat1-run'))
    fireEvent.click(screen.getByTestId('beat-1-advance'))

    // Now Beat 2 is the single active beat; Beat 1 is a collapsed summary.
    expect(screen.getByTestId('beat-2-active')).toBeInTheDocument()
    expect(screen.getByTestId('lesson-beat-2')).toBeInTheDocument()
    expect(screen.getByTestId('beat-1-summary')).toBeInTheDocument()
    // Collapsed → the interactive Beat 1 is not mounted.
    expect(screen.queryByTestId('lesson-beat-1-interactive')).toBeNull()
    expect(screen.getByTestId('lesson-stepper-stop-1')).toHaveAttribute('data-state', 'past')
    expect(screen.getByTestId('lesson-stepper-stop-2')).toHaveAttribute('data-state', 'active')

    // Reopening the summary re-mounts Beat 1 for review.
    fireEvent.click(screen.getByTestId('beat-1-summary-toggle'))
    expect(screen.getByTestId('beat-1-summary-body')).toBeInTheDocument()
    expect(screen.getByTestId('lesson-beat-1-interactive')).toBeInTheDocument()
  })

  it('reaches the gated graduation only after stepping through all beats', () => {
    render(<LessonJourney initialThreshold={0.85} beat2={<LessonBeat2 />} />)
    // Graduation is not reachable from Beat 1.
    expect(screen.queryByTestId('lesson-beat-3')).toBeNull()

    fireEvent.click(screen.getByTestId('beat1-source-summary'))
    fireEvent.click(screen.getByTestId('beat1-run'))
    fireEvent.click(screen.getByTestId('beat-1-advance'))
    fireEvent.click(screen.getByTestId('beat-2-advance'))

    // Beat 3 is now active and still gates the graduation behind "finish".
    expect(screen.getByTestId('beat-3-active')).toBeInTheDocument()
    expect(screen.queryByTestId('lesson-graduation')).toBeNull()
    fireEvent.click(screen.getByTestId('beat3-finish-btn'))
    expect(screen.getByTestId('lesson-graduation')).toBeInTheDocument()
  })
})
