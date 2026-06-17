import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import NotebookStartPage from '../page'

describe('Notebook front page (SHA-156 N6)', () => {
  it('renders two co-equal actions pointing at the sandbox and the worked example', () => {
    render(<NotebookStartPage />)
    const sandbox = screen.getByTestId('action-open-sandbox')
    const example = screen.getByTestId('action-worked-example')
    expect(sandbox).toHaveAttribute('href', '/notebook')
    expect(example).toHaveAttribute('href', '/notebook?example=1')
    // co-equal: both carry the same button class (no primary/secondary split)
    expect(sandbox.className).toBe(example.className)
  })

  it('shows honest, synthetic-data copy', () => {
    render(<NotebookStartPage />)
    const honesty = screen.getByTestId('front-honesty')
    expect(honesty).toHaveTextContent(/synthetic/i)
    expect(honesty).toHaveTextContent(/no real PHI/i)
  })

  it('uses single-patient framing — NO cohort/analytics phrasing', () => {
    const { container } = render(<NotebookStartPage />)
    const text = (container.textContent ?? '').toLowerCase()
    for (const banned of [
      'cohort',
      'analytics',
      'at scale',
      'across patients',
      'aggregate',
      'dashboard',
      'population',
    ]) {
      expect(text).not.toContain(banned)
    }
  })
})
