import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LessonBeat2 } from '../LessonBeat2'

/**
 * Beat 2 render acceptance (SHA-61 R9). The component is fully determined by the
 * committed fixture, so these assert the three acceptance behaviours are visible
 * on screen: the diff fails on prose, the reference judge resolves it, and the
 * judge-fallibility seed is present.
 */
describe('LessonBeat2 (prose contrast)', () => {
  it('shows the structured diff failing on the prose answer (errored, no score)', () => {
    render(<LessonBeat2 />)
    expect(screen.getByTestId('beat2-diff-failed')).toBeInTheDocument()
    expect(screen.getByTestId('beat2-diff-status')).toHaveTextContent(/errored/i)
    expect(screen.getByTestId('beat2-diff-score')).toHaveTextContent('—')
    expect(screen.getByTestId('beat2-diff-error-message')).toHaveTextContent(/not valid JSON/i)
  })

  it('shows the reference judge resolving it as equivalent (1.00)', () => {
    render(<LessonBeat2 />)
    expect(screen.getByTestId('beat2-verdict')).toHaveTextContent('equivalent')
    expect(screen.getByTestId('beat2-judge-score')).toHaveTextContent('1.00')
    expect(screen.getByTestId('beat2-judge-reason')).toHaveTextContent(/8\.2%/)
  })

  it('renders the judge-fallibility seed (this judge can be wrong too)', () => {
    render(<LessonBeat2 />)
    expect(screen.getByTestId('beat2-fallibility-seed')).toHaveTextContent(
      /fallible|not the ground truth|not an oracle/i,
    )
  })

  it('persists only a redacted judge prompt (no raw prose)', () => {
    render(<LessonBeat2 />)
    const prompt = screen.getByTestId('beat2-judge-prompt').textContent ?? ''
    expect(prompt).toContain('redacted sha256=')
    expect(prompt).not.toContain('hemoglobin')
  })

  it('renders identically on repeated mounts (no flap)', () => {
    const first = render(<LessonBeat2 />)
    const html = first.container.innerHTML
    first.unmount()
    const second = render(<LessonBeat2 />)
    expect(second.container.innerHTML).toBe(html)
  })
})
