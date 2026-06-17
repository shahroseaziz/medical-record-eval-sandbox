/*
 * ExplorerDrawer (N7a): the sortable all-patients table. Asserts the six columns
 * render, sorting works on each column, and a row click hits the N7b stub target.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ExplorerDrawer } from '../ExplorerDrawer'
import type { AllPatientsResponse, ExplorerPatient } from '../types'

const PATIENTS: ExplorerPatient[] = [
  { id: 'a', name: 'Adams, Carol', summary: {}, age: 71, sex: 'F', conditionCount: 5, medCount: 1, chartBytes: 30000 },
  { id: 'b', name: 'Brown, Alan', summary: {}, age: 40, sex: 'M', conditionCount: 2, medCount: 9, chartBytes: 5000 },
  { id: 'c', name: 'Clark, Beth', summary: {}, age: 55, sex: 'F', conditionCount: 8, medCount: 4, chartBytes: 18000 },
]

const RESPONSE: AllPatientsResponse = { patients: PATIENTS, count: PATIENTS.length }

function mockFetch(response: AllPatientsResponse = RESPONSE) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => response,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** Names in the order they appear in the rendered <tbody>. */
function renderedNames(): string[] {
  const body = screen.getByRole('table').querySelector('tbody')!
  return within(body as HTMLElement)
    .getAllByRole('button')
    .map((row) => (row.querySelector('td')?.textContent ?? '').trim())
}

describe('ExplorerDrawer — sortable all-patients table', () => {
  beforeEach(() => mockFetch())
  afterEach(() => vi.unstubAllGlobals())

  async function open() {
    const onClose = vi.fn()
    const onSelectPatient = vi.fn()
    render(<ExplorerDrawer open onClose={onClose} onSelectPatient={onSelectPatient} />)
    await screen.findByTestId('patient-row-a')
    return { onClose, onSelectPatient }
  }

  it('renders the six columns', async () => {
    await open()
    for (const label of ['Patient', 'Age', 'Sex', 'Cond', 'Meds', 'Chart']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument()
    }
  })

  it('defaults to name ascending', async () => {
    await open()
    expect(renderedNames()).toEqual(['Adams, Carol', 'Brown, Alan', 'Clark, Beth'])
  })

  it('toggles name sort direction on repeated header clicks', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByTestId('sort-name'))
    expect(renderedNames()).toEqual(['Clark, Beth', 'Brown, Alan', 'Adams, Carol'])
    await user.click(screen.getByTestId('sort-name'))
    expect(renderedNames()).toEqual(['Adams, Carol', 'Brown, Alan', 'Clark, Beth'])
  })

  it('sorts by age (numeric column defaults to descending)', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByTestId('sort-age'))
    expect(renderedNames()).toEqual(['Adams, Carol', 'Clark, Beth', 'Brown, Alan']) // 71, 55, 40
    await user.click(screen.getByTestId('sort-age'))
    expect(renderedNames()).toEqual(['Brown, Alan', 'Clark, Beth', 'Adams, Carol']) // 40, 55, 71
  })

  it('sorts by sex', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByTestId('sort-sex')) // F, F, M asc
    expect(renderedNames().at(-1)).toBe('Brown, Alan')
  })

  it('sorts by condition count', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByTestId('sort-conditionCount'))
    expect(renderedNames()).toEqual(['Clark, Beth', 'Adams, Carol', 'Brown, Alan']) // 8, 5, 2
  })

  it('sorts by med count', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByTestId('sort-medCount'))
    expect(renderedNames()).toEqual(['Brown, Alan', 'Clark, Beth', 'Adams, Carol']) // 9, 4, 1
  })

  it('sorts by chart size', async () => {
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByTestId('sort-chartBytes'))
    expect(renderedNames()).toEqual(['Adams, Carol', 'Clark, Beth', 'Brown, Alan']) // 30k, 18k, 5k
  })

  it('formats chart size as KB', async () => {
    await open()
    const row = screen.getByTestId('patient-row-b')
    expect(within(row).getByText('5 KB')).toBeInTheDocument()
  })

  it('fires the N7b stub target (onSelectPatient) on row click', async () => {
    const user = userEvent.setup()
    const { onSelectPatient } = await open()
    await user.click(screen.getByTestId('patient-row-c'))
    expect(onSelectPatient).toHaveBeenCalledTimes(1)
    expect(onSelectPatient.mock.calls[0][0]).toMatchObject({ id: 'c', name: 'Clark, Beth' })
  })

  it('requests the ?all=1 endpoint (no random/limit sampling)', async () => {
    const fetchMock = mockFetch()
    render(<ExplorerDrawer open onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith('/api/patients?all=1')
  })

  it('surfaces a load error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
    render(<ExplorerDrawer open onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to load patients/)
  })
})

describe('ExplorerDrawer — row → chart detail (N7b)', () => {
  // Branch fetch by URL: the table endpoint returns patients; the chunks endpoint
  // returns one section so the detail renders without hitting the network.
  function mockBranchedFetch() {
    const fetchMock = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('chunks')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            chunks: [{ section: 'problems', ord: 0, text: 'Hypertension', source_xml: '<section>X</section>' }],
          }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => RESPONSE })
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => vi.unstubAllGlobals())

  it('opens the chart detail on row click and backs out to the table', async () => {
    const user = userEvent.setup()
    mockBranchedFetch()
    render(<ExplorerDrawer open onClose={vi.fn()} chunksEndpoint="/api/patients/c/chunks" />)
    await user.click(await screen.findByTestId('patient-row-c'))

    // Detail replaces the table; the section renders.
    expect(await screen.findByTestId('patient-chart-detail')).toBeInTheDocument()
    expect(screen.getByTestId('section-problems')).toHaveTextContent('Hypertension')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()

    // Back returns to the table.
    await user.click(screen.getByTestId('chart-back'))
    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByTestId('patient-chart-detail')).not.toBeInTheDocument()
  })

  it('resets the selection when the drawer closes (reopening lands on the table)', async () => {
    const user = userEvent.setup()
    mockBranchedFetch()
    const { rerender } = render(
      <ExplorerDrawer open onClose={vi.fn()} chunksEndpoint="/api/patients/c/chunks" />,
    )
    await user.click(await screen.findByTestId('patient-row-c'))
    expect(await screen.findByTestId('patient-chart-detail')).toBeInTheDocument()

    rerender(<ExplorerDrawer open={false} onClose={vi.fn()} chunksEndpoint="/api/patients/c/chunks" />)
    rerender(<ExplorerDrawer open onClose={vi.fn()} chunksEndpoint="/api/patients/c/chunks" />)

    expect(await screen.findByRole('table')).toBeInTheDocument()
    expect(screen.queryByTestId('patient-chart-detail')).not.toBeInTheDocument()
  })
})
