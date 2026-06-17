/*
 * State-preservation harness (N7a acceptance): opening and closing the Explore
 * drawer must NEVER unmount the notebook. We render a fake notebook with a prompt
 * textarea and a mount counter inside <ExplorerShell>, type in-progress text, run a
 * full open → close cycle on the drawer, and assert:
 *   1. the prompt text survives the cycle, and
 *   2. the notebook mounted exactly once (no remount).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useRef, useState } from 'react'
import { ExplorerShell } from '../ExplorerShell'
import type { AllPatientsResponse } from '../types'

const FIXTURE: AllPatientsResponse = {
  count: 1,
  patients: [
    {
      id: 'p1',
      name: 'Adams, Jane',
      summary: {},
      age: 60,
      sex: 'F',
      conditionCount: 3,
      medCount: 2,
      chartBytes: 12000,
    },
  ],
}

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => FIXTURE,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/** A stand-in notebook: a prompt textarea plus a mount counter exposed via a ref. */
function FakeNotebook({ mountCounter }: { mountCounter: { current: number } }) {
  const [text, setText] = useState('')
  const counted = useRef(false)
  useEffect(() => {
    if (!counted.current) {
      counted.current = true
      mountCounter.current += 1
    }
  }, [mountCounter])
  return (
    <textarea
      aria-label="prompt"
      value={text}
      onChange={(e) => setText(e.target.value)}
    />
  )
}

describe('ExplorerShell — notebook state preservation', () => {
  beforeEach(() => mockFetchOk())
  afterEach(() => vi.unstubAllGlobals())

  it('preserves in-progress prompt text across an open → close cycle', async () => {
    const user = userEvent.setup()
    const mountCounter = { current: 0 }

    render(
      <ExplorerShell>
        <FakeNotebook mountCounter={mountCounter} />
      </ExplorerShell>,
    )

    const prompt = screen.getByLabelText('prompt') as HTMLTextAreaElement
    await user.type(prompt, 'summarize the diabetes meds')
    expect(prompt.value).toBe('summarize the diabetes meds')
    expect(mountCounter.current).toBe(1)

    // Open the drawer.
    await user.click(screen.getByTestId('explore-trigger'))
    const drawer = screen.getByTestId('explorer-drawer')
    await waitFor(() => expect(drawer.className).toMatch(/open/))
    // Table loaded (proves the drawer is live), but the notebook is untouched.
    await screen.findByTestId('patient-row-p1')

    // Close the drawer.
    await user.click(screen.getByLabelText('Close'))
    await waitFor(() => expect(drawer.className).not.toMatch(/open/))

    // The notebook never unmounted: same DOM node, same text, mounted exactly once.
    const promptAfter = screen.getByLabelText('prompt') as HTMLTextAreaElement
    expect(promptAfter).toBe(prompt)
    expect(promptAfter.value).toBe('summarize the diabetes meds')
    expect(mountCounter.current).toBe(1)
  })

  it('fetches the full corpus via ?all=1 (no random/limit sampling)', async () => {
    const fetchMock = mockFetchOk()
    const user = userEvent.setup()

    render(
      <ExplorerShell>
        <div>notebook</div>
      </ExplorerShell>,
    )

    await user.click(screen.getByTestId('explore-trigger'))
    await screen.findByTestId('patient-row-p1')

    expect(fetchMock).toHaveBeenCalledWith('/api/patients?all=1')
    // Never the random-sample path.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toMatch(/[?&]n=/)
      expect(String(call[0])).not.toMatch(/random|limit|sample/)
    }
  })

  it('does not unmount the notebook while the drawer is open (overlay, not flex collapse)', async () => {
    const user = userEvent.setup()
    const mountCounter = { current: 0 }

    render(
      <ExplorerShell>
        <FakeNotebook mountCounter={mountCounter} />
      </ExplorerShell>,
    )

    const prompt = screen.getByLabelText('prompt') as HTMLTextAreaElement
    await user.type(prompt, 'draft')

    await user.click(screen.getByTestId('explore-trigger'))
    await screen.findByTestId('patient-row-p1')

    // Mid-open, the notebook node and its in-progress text are still present.
    expect((screen.getByLabelText('prompt') as HTMLTextAreaElement).value).toBe('draft')
    expect(mountCounter.current).toBe(1)
  })
})
