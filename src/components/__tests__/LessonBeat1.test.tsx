import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { LessonBeat1 } from '../LessonBeat1'

/**
 * Acceptance test for SHA-60 R8 — the interactive Beat 1 on-ramp:
 *  1. the generation prompt is visible,
 *  2. authoring precedes the run (the diff is gated behind picking a source),
 *  3. both honest outcomes land: summary → "untested key", record → "the discipline",
 *  4. it runs on the seeded R7 generation.
 */
describe('LessonBeat1 (correctness with a diff)', () => {
  it('shows the generation prompt and the seeded model output', () => {
    render(<LessonBeat1 />)
    expect(screen.getByTestId('beat1-generation-prompt')).toHaveTextContent(
      'extract this patient',
    )
    // The graded artifact is the committed/seeded output, present before any run.
    expect(screen.getByTestId('beat1-model-output')).toHaveTextContent('Amlodipine')
  })

  it('gates the diff behind authoring: run is disabled and no diff until a source is picked', () => {
    render(<LessonBeat1 />)
    expect(screen.getByTestId('beat1-run')).toBeDisabled()
    expect(screen.queryByTestId('beat1-diff-table')).toBeNull()
    expect(screen.queryByTestId('beat1-outcome')).toBeNull()
  })

  it('keeps the full record one click away', () => {
    render(<LessonBeat1 />)
    expect(screen.getByTestId('beat1-full-record')).toHaveTextContent('full record')
    expect(screen.getByTestId('beat1-full-record-text')).toHaveTextContent('2.5 MG')
  })

  it('authoring from the summary yields a green diff against a wrong reference (untested key)', () => {
    render(<LessonBeat1 />)
    fireEvent.click(screen.getByTestId('beat1-source-summary'))
    // The authored key is shown before running — authoring precedes the run.
    expect(screen.getByTestId('beat1-authored-key')).toHaveTextContent('amlodipine')
    expect(screen.queryByTestId('beat1-diff-table')).toBeNull()

    fireEvent.click(screen.getByTestId('beat1-run'))
    expect(screen.getByTestId('beat1-f1')).toHaveTextContent('100.0%')
    expect(screen.queryAllByTestId('beat1-diff-row-mismatch')).toHaveLength(0)
    const outcome = screen.getByTestId('beat1-outcome')
    expect(outcome).toHaveAttribute('data-source', 'summary')
    expect(screen.getByTestId('beat1-outcome-headline')).toHaveTextContent('untested key')
  })

  it('authoring from the record catches the dose error (the discipline)', () => {
    render(<LessonBeat1 />)
    fireEvent.click(screen.getByTestId('beat1-source-record'))
    fireEvent.click(screen.getByTestId('beat1-run'))

    expect(screen.getByTestId('beat1-f1')).toHaveTextContent('91.7%')
    const mismatches = screen.getAllByTestId('beat1-diff-row-mismatch')
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]).toHaveTextContent('amlodipine')
    expect(mismatches[0]).toHaveTextContent('2.5 mg')
    expect(mismatches[0]).toHaveTextContent('5 mg')

    const outcome = screen.getByTestId('beat1-outcome')
    expect(outcome).toHaveAttribute('data-source', 'record')
    expect(screen.getByTestId('beat1-outcome-headline')).toHaveTextContent('discipline')
  })

  it('re-authoring after a run hides the diff again (authoring precedes the run)', () => {
    render(<LessonBeat1 />)
    fireEvent.click(screen.getByTestId('beat1-source-summary'))
    fireEvent.click(screen.getByTestId('beat1-run'))
    expect(screen.getByTestId('beat1-diff-table')).toBeInTheDocument()

    // Switching the source resets the run — the learner must run the new key.
    fireEvent.click(screen.getByTestId('beat1-source-record'))
    expect(screen.queryByTestId('beat1-diff-table')).toBeNull()
  })
})
