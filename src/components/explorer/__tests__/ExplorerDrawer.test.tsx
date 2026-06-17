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
