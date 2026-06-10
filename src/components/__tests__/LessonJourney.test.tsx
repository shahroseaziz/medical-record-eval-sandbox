import { describe, it, expect, beforeAll, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LessonJourney } from '../LessonJourney'
import { LessonBeat2 } from '../LessonBeat2'

/**
 * Acceptance test for SHA-71 R15 — the lesson app shell:
 *  1. a persistent stepper rail (Match → Meaning → Grounding),
 *  2. exactly one beat interactive at a time,
 *  3. advancing is GATED on completing the current beat (Beat 1's run); Beat 2
 *     advances via the reference's forward-pulling CTA,
 *  4. finished beats collapse to a reopenable summary that PRESERVES the
 *     learner's state (reopening is a review, not a reset), and stepping back
 *     and forward never wipes a later beat's state,
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

    // Reopening the summary re-mounts Beat 1 for review WITH the learner's state
    // intact — the source they authored from is still selected (a review, not a
    // reset). The lifted state survives the collapse/reopen round-trip.
    fireEvent.click(screen.getByTestId('beat-1-summary-toggle'))
    expect(screen.getByTestId('beat-1-summary-body')).toBeInTheDocument()
    const reopened = screen.getByTestId('lesson-beat-1-interactive')
    expect(reopened).toBeInTheDocument()
    expect(screen.getByTestId('beat1-source-summary')).toHaveAttribute('aria-pressed', 'true')
    // The run result is preserved too — the diff is still on screen, not reset.
    expect(screen.getByTestId('beat1-diff-table')).toBeInTheDocument()
  })

  it('advances from Beat 2 to Beat 3 via the forward-pulling CTA', () => {
    render(<LessonJourney initialThreshold={0.85} beat2={<LessonBeat2 />} />)
    fireEvent.click(screen.getByTestId('beat1-source-summary'))
    fireEvent.click(screen.getByTestId('beat1-run'))
    fireEvent.click(screen.getByTestId('beat-1-advance'))

    // Beat 2 is fully shown, so the advance is the reference's forward CTA — it
    // pulls toward Beat 3's "no answer key at all", not a self-attestation check.
    const advance = screen.getByTestId('beat-2-advance')
    expect(advance).toHaveTextContent('no answer to write down')
    fireEvent.click(advance)
    expect(screen.getByTestId('beat-3-active')).toBeInTheDocument()
  })

  it('preserves Beat 3 state when stepping back to an earlier beat and returning', () => {
    render(<LessonJourney initialThreshold={0.85} beat2={<LessonBeat2 />} />)
    fireEvent.click(screen.getByTestId('beat1-source-summary'))
    fireEvent.click(screen.getByTestId('beat1-run'))
    fireEvent.click(screen.getByTestId('beat-1-advance'))
    fireEvent.click(screen.getByTestId('beat-2-advance'))

    // On Beat 3, move the rubric to lenient — this is the state graduation hands
    // off to the workbench.
    fireEvent.click(screen.getByTestId('beat3-rubric-lenient'))
    expect(screen.getByTestId('beat3-mean-score')).toHaveTextContent('75.0%')

    // Step back to Beat 1 via the stepper, then forward again to Beat 3.
    fireEvent.click(screen.getByTestId('lesson-stepper-stop-1'))
    expect(screen.getByTestId('beat-1-active')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('lesson-stepper-stop-3'))

    // Beat 3's lenient rubric survived the round-trip — it was not wiped.
    expect(screen.getByTestId('beat3-rubric-lenient')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('beat3-mean-score')).toHaveTextContent('75.0%')
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
