import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LessonView } from '../LessonView'
import { loadLesson } from '@/lib/lesson'

/**
 * Acceptance test for the lesson's Beat 1 (SHA-59 R7): the deterministic
 * structured diff produces IDENTICAL results on every load. The lesson reads only
 * committed data (the baseline + seed-case fixtures), so this asserts both the
 * exact committed values and byte-stable re-renders — i.e. no live generation / no
 * flap. Beat 2 (the prose contrast) moved to its own component; see
 * LessonBeat2.test.tsx.
 */
describe('LessonView (committed correctness lesson)', () => {
  const lesson = loadLesson()

  it('loads the committed lesson case', () => {
    expect(lesson).not.toBeNull()
    expect(lesson!.caseId).toBe('lesson-marisela-medications-structured-diff')
  })

  it('Beat-1 renders the deterministic F1 (91.7%)', () => {
    render(<LessonView data={lesson!} />)
    expect(screen.getByTestId('lesson-f1')).toHaveTextContent('91.7%')
  })

  it('Beat-1 surfaces exactly one mismatch row: amlodipine 2.5 mg vs 5 mg', () => {
    render(<LessonView data={lesson!} />)
    const mismatches = screen.getAllByTestId('lesson-diff-row-mismatch')
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]).toHaveTextContent('amlodipine')
    expect(mismatches[0]).toHaveTextContent('2.5 mg')
    expect(mismatches[0]).toHaveTextContent('5 mg')
    expect(lesson!.beat1.mismatchCount).toBe(1)
    expect(lesson!.beat1.missingCount).toBe(0)
    expect(lesson!.beat1.extraCount).toBe(0)
  })

  it('renders identically on repeated loads (no flap)', () => {
    const a = loadLesson()
    const b = loadLesson()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))

    const first = render(<LessonView data={a!} />)
    const firstHtml = first.container.innerHTML
    first.unmount()
    const second = render(<LessonView data={b!} />)
    expect(second.container.innerHTML).toBe(firstHtml)
  })
})
