import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { RagInspector } from '../RagInspector'

const MISS = 'rag-agustin-specialist-retrieve-miss'
const HIT = 'rag-brenna-allergies-retrieve-hit'

function renderInspector() {
  return render(<RagInspector />)
}

describe('RagInspector (O10 / G4)', () => {
  it('renders the chunk view with distance and similarity per chunk', () => {
    renderInspector()
    fireEvent.click(screen.getByTestId(`rag-case-select-${MISS}`))
    fireEvent.click(screen.getByTestId('rag-mode-retrieve'))
    expect(screen.getByTestId('rag-chunk-0-distance')).toHaveTextContent(/dist/)
    expect(screen.getByTestId('rag-chunk-0-similarity')).toHaveTextContent(/sim/)
  })

  it('the miss case fires section_hit=false over the inBudget subset, with a budget-miss note', () => {
    renderInspector()
    fireEvent.click(screen.getByTestId(`rag-case-select-${MISS}`))
    fireEvent.click(screen.getByTestId('rag-mode-retrieve'))

    expect(screen.getByTestId('rag-section-hit')).toHaveAttribute('data-hit', '0')
    expect(screen.getByTestId('rag-section-hit-missing')).toHaveTextContent('specialist')
    expect(screen.getByTestId('rag-budget-miss-note')).toBeInTheDocument()
    // The budget-dropped chunk is dimmed and flagged.
    expect(screen.getByTestId('rag-chunk-5')).toHaveAttribute('data-dropped', 'true')
    expect(screen.getByTestId('rag-chunk-0')).toHaveAttribute('data-dropped', 'false')
  })

  it('shows a grounding difference between retrieve and stuff for the same case', () => {
    renderInspector()
    fireEvent.click(screen.getByTestId(`rag-case-select-${MISS}`))

    fireEvent.click(screen.getByTestId('rag-mode-retrieve'))
    const retrieveG = screen.getByTestId('rag-grounding').textContent ?? ''

    fireEvent.click(screen.getByTestId('rag-mode-stuff'))
    const stuffG = screen.getByTestId('rag-grounding').textContent ?? ''

    expect(stuffG).not.toEqual(retrieveG)
    expect(stuffG.length).toBeGreaterThan(retrieveG.length)
    expect(retrieveG).not.toContain('[specialist]')
    expect(stuffG).toContain('[specialist]')
  })

  it('stuff mode reports section_hit as N/A (no retrieval step)', () => {
    renderInspector()
    fireEvent.click(screen.getByTestId(`rag-case-select-${MISS}`))
    fireEvent.click(screen.getByTestId('rag-mode-stuff'))
    expect(screen.getByTestId('rag-stuff-note')).toHaveTextContent('N/A')
    expect(screen.queryByTestId('rag-section-hit')).not.toBeInTheDocument()
  })

  it('the small-patient case carries the non-selective honesty note and hits', () => {
    renderInspector()
    fireEvent.click(screen.getByTestId(`rag-case-select-${HIT}`))
    fireEvent.click(screen.getByTestId('rag-mode-retrieve'))
    expect(screen.getByTestId('rag-section-hit')).toHaveAttribute('data-hit', '1')
    expect(screen.getByTestId('rag-nonselective-note')).toHaveTextContent(/non-selective/)
  })

  it('the section_hit term tooltip carries specialist copy #94 verbatim', () => {
    renderInspector()
    fireEvent.click(screen.getByTestId(`rag-case-select-${MISS}`))
    fireEvent.click(screen.getByTestId('rag-mode-retrieve'))
    const term = screen.getAllByTestId('term-section-hit')[0]
    expect(term).toHaveAttribute(
      'aria-label',
      expect.stringContaining('section_hit is a coarse, section-level recall signal'),
    )
    // Revealing the tooltip surfaces the same line.
    fireEvent.focus(term)
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'section_hit is a coarse, section-level recall signal',
    )
  })

  it('renders the ingest chunk-count histogram with the 6 MB outlier bucket', () => {
    renderInspector()
    const hist = screen.getByTestId('rag-histogram')
    expect(hist).toHaveTextContent('Chunks per patient at ingest')
    expect(within(hist).getByTestId('rag-histogram-bar-33+')).toBeInTheDocument()
  })
})
