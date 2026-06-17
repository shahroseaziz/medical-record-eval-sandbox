/*
 * PatientChartDetail (N7b): parsed-section render + Parsed/Raw-XML toggle.
 * Asserts sections group by clinical section with human labels, the toggle shows
 * section-level source_xml, a null source_xml shows a NAMED state (not blank),
 * sparse charts don't crash, and the long-list progressive reveal works (the perf
 * guard against the ~6 MB outlier rendering every chunk synchronously).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PatientChartDetail } from '../PatientChartDetail'
import type { ChunkRow, ChunksResponse, ExplorerPatient } from '../types'

const PATIENT: ExplorerPatient = {
  id: 'p1',
  name: 'Doe, John',
  summary: {},
  age: 64,
  sex: 'M',
  conditionCount: 3,
  medCount: 2,
  chartBytes: 1000,
}

const CHUNKS: ChunkRow[] = [
  { section: 'problems', ord: 0, text: 'Hypertension; Type 2 Diabetes', source_xml: '<section>PROB-XML</section>' },
  { section: 'medications', ord: 0, text: 'Lisinopril 10mg daily', source_xml: '<section>MED-XML</section>' },
  { section: 'results', ord: 0, text: 'HbA1c 7.2 %', source_xml: '<section>LAB-XML</section>' },
  { section: 'encounters', ord: 0, text: 'Office visit 2024-03-01', source_xml: null },
]

function mockChunks(chunks: ChunkRow[] = CHUNKS) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async (): Promise<ChunksResponse> => ({ chunks }),
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function renderDetail(chunks?: ChunkRow[]) {
  mockChunks(chunks)
  render(<PatientChartDetail patient={PATIENT} endpoint="/test-chunks" />)
  await screen.findByTestId('patient-chart-detail')
}

describe('PatientChartDetail — parsed sections + raw-XML toggle', () => {
  beforeEach(() => mockChunks())
  afterEach(() => vi.unstubAllGlobals())

  it('renders parsed sections grouped by clinical section with human labels', async () => {
    await renderDetail()
    expect(await screen.findByTestId('section-problems')).toHaveTextContent('Problems')
    expect(screen.getByTestId('section-medications')).toHaveTextContent('Medications')
    // `results` surfaces under the "Labs" label per the spec.
    expect(screen.getByTestId('section-results')).toHaveTextContent('Labs')
    expect(screen.getByTestId('section-encounters')).toHaveTextContent('Encounters')
    expect(screen.getByTestId('section-problems')).toHaveTextContent('Hypertension; Type 2 Diabetes')
  })

  it('defaults to Parsed view', async () => {
    await renderDetail()
    await screen.findByTestId('section-problems')
    expect(screen.getByTestId('view-parsed')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('view-raw')).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggles to Raw XML and shows each section source_xml', async () => {
    const user = userEvent.setup()
    await renderDetail()
    await screen.findByTestId('section-problems')
    await user.click(screen.getByTestId('view-raw'))
    expect(screen.getByTestId('raw-section-problems')).toHaveTextContent('<section>PROB-XML</section>')
    expect(screen.getByTestId('raw-section-results')).toHaveTextContent('<section>LAB-XML</section>')
  })

  it('shows a NAMED unavailable state (not blank) for a section with null source_xml', async () => {
    const user = userEvent.setup()
    await renderDetail()
    await screen.findByTestId('section-problems')
    await user.click(screen.getByTestId('view-raw'))
    const enc = screen.getByTestId('raw-section-encounters')
    expect(within(enc).getByTestId('raw-unavailable-encounters')).toHaveTextContent(/raw xml unavailable/i)
  })

  it('does not crash on a patient with sparse sections (single section only)', async () => {
    await renderDetail([{ section: 'problems', ord: 0, text: 'Asthma', source_xml: '<section>P</section>' }])
    expect(await screen.findByTestId('section-problems')).toHaveTextContent('Asthma')
    expect(screen.queryByTestId('section-medications')).not.toBeInTheDocument()
  })

  it('shows a named empty state for a patient with no chunks', async () => {
    await renderDetail([])
    expect(await screen.findByTestId('chart-empty')).toHaveTextContent(/no parsed sections/i)
  })

  it('progressively reveals a long section instead of rendering every chunk at once', async () => {
    const user = userEvent.setup()
    // 30 chunks in one section (> the 25 initial cap) — stands in for the labs outlier.
    const many: ChunkRow[] = Array.from({ length: 30 }, (_, i) => ({
      section: 'results',
      ord: i,
      text: `lab row ${i}`,
      source_xml: '<section>L</section>',
    }))
    await renderDetail(many)
    const sec = await screen.findByTestId('section-results')
    // Section count badge reflects the FULL count even though only 25 are rendered.
    expect(sec).toHaveTextContent('30')
    expect(within(sec).getByText('lab row 24')).toBeInTheDocument()
    expect(within(sec).queryByText('lab row 25')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('show-more-results'))
    expect(within(sec).getByText('lab row 29')).toBeInTheDocument()
  })

  it('surfaces a load error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'Database error' }) }),
    )
    render(<PatientChartDetail patient={PATIENT} endpoint="/test-chunks" />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Database error/)
  })
})
