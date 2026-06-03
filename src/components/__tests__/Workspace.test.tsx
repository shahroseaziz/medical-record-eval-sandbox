import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock sessionStorage & localStorage for ApiKeyInput and UserCaseManager
const mockSessionStorage: Record<string, string> = {}
const mockLocalStorage: Record<string, string> = {}

Object.defineProperty(window, 'sessionStorage', {
  value: {
    getItem: (k: string) => mockSessionStorage[k] ?? null,
    setItem: (k: string, v: string) => { mockSessionStorage[k] = v },
    removeItem: (k: string) => { delete mockSessionStorage[k] },
    clear: () => { Object.keys(mockSessionStorage).forEach((k) => delete mockSessionStorage[k]) },
  },
  writable: true,
})

Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (k: string) => mockLocalStorage[k] ?? null,
    setItem: (k: string, v: string) => { mockLocalStorage[k] = v },
    removeItem: (k: string) => { delete mockLocalStorage[k] },
    clear: () => { Object.keys(mockLocalStorage).forEach((k) => delete mockLocalStorage[k]) },
  },
  writable: true,
})

// Fixture patient
const MOCK_PATIENT = {
  id: 'p-test-001',
  name: 'Alice Smith',
  summary: {
    demographics: { firstName: 'Alice', lastName: 'Smith', gender: 'F', birthDate: '19750605' },
    sections: ['medications', 'allergies'],
  },
}

// Fixture stream — AI SDK data stream protocol
const FIXTURE_STREAM = [
  `2:[{"type":"retrieval","chunks":[{"section":"medications","text":"Lisinopril 10mg daily","distance":0.12,"similarity":0.88}],"groundingContext":"[medications]\\nLisinopril 10mg daily"}]`,
  `0:"The patient takes Lisinopril 10mg daily."`,
  `d:{"finishReason":"stop","usage":{"promptTokens":100,"completionTokens":10}}`,
  `2:[{"type":"eval","faithfulness":{"scorer":"faithfulness","score":0.95,"claims":[{"claim":"Patient takes Lisinopril 10mg daily","verdict":"supported","rationale":"explicitly stated"}],"extractPrompt":"extract","verdictPrompt":"verdict"},"sectionHit":{"scorer":"section-hit","score":null,"requiredSections":[],"retrievedSections":["medications"],"missingSections":[]}}]`,
].join('\n')

function makeReadableStream(body: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
}

// ── Component-level imports (after mocks) ─────────────────────────────────────
import { PatientBrowser } from '../PatientBrowser'
import { RagModeToggle } from '../RagModeToggle'
import { UserCaseManager } from '../UserCaseManager'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PatientBrowser', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the get-patients button', () => {
    render(<PatientBrowser selectedId={null} onSelect={() => {}} />)
    expect(screen.getByTestId('get-patients-btn')).toBeInTheDocument()
  })

  it('calls /api/patients?n=5 on click and renders patient cards', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ patients: [MOCK_PATIENT] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const user = userEvent.setup()
    render(<PatientBrowser selectedId={null} onSelect={() => {}} />)

    await user.click(screen.getByTestId('get-patients-btn'))

    await waitFor(() => {
      expect(screen.getByTestId(`patient-card-${MOCK_PATIENT.id}`)).toBeInTheDocument()
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/patients?n=5')
    expect(screen.getByText('Alice Smith')).toBeInTheDocument()
  })

  it('calls onSelect when a patient card is clicked', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ patients: [MOCK_PATIENT] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const onSelect = vi.fn()
    const user = userEvent.setup()
    render(<PatientBrowser selectedId={null} onSelect={onSelect} />)

    await user.click(screen.getByTestId('get-patients-btn'))
    await waitFor(() => screen.getByTestId(`patient-card-${MOCK_PATIENT.id}`))
    await user.click(screen.getByTestId(`patient-card-${MOCK_PATIENT.id}`))

    expect(onSelect).toHaveBeenCalledWith(MOCK_PATIENT)
  })

  it('shows error when fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Database unavailable' }),
    }))

    const user = userEvent.setup()
    render(<PatientBrowser selectedId={null} onSelect={() => {}} />)
    await user.click(screen.getByTestId('get-patients-btn'))

    await waitFor(() => {
      expect(screen.getByText('Database unavailable')).toBeInTheDocument()
    })
  })
})

describe('RagModeToggle', () => {
  it('renders in retrieve mode by default', () => {
    render(
      <RagModeToggle mode="retrieve" onChange={() => {}} record="" onRecordChange={() => {}} />,
    )
    expect(screen.getByTestId('mode-toggle')).toHaveTextContent('retrieve')
  })

  it('calls onChange with "stuff" when toggled from retrieve', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <RagModeToggle mode="retrieve" onChange={onChange} record="" onRecordChange={() => {}} />,
    )
    await user.click(screen.getByTestId('mode-toggle'))
    expect(onChange).toHaveBeenCalledWith('stuff')
  })

  it('calls onChange with "retrieve" when toggled from stuff', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <RagModeToggle mode="stuff" onChange={onChange} record="" onRecordChange={() => {}} />,
    )
    await user.click(screen.getByTestId('mode-toggle'))
    expect(onChange).toHaveBeenCalledWith('retrieve')
  })

  it('shows record textarea in stuff mode', () => {
    render(
      <RagModeToggle mode="stuff" onChange={() => {}} record="" onRecordChange={() => {}} />,
    )
    expect(screen.getByTestId('record-input')).toBeInTheDocument()
  })

  it('does not show record textarea in retrieve mode', () => {
    render(
      <RagModeToggle mode="retrieve" onChange={() => {}} record="" onRecordChange={() => {}} />,
    )
    expect(screen.queryByTestId('record-input')).not.toBeInTheDocument()
  })
})

describe('UserCaseManager', () => {
  beforeEach(() => {
    mockLocalStorage['user_cases_v1'] = '[]'
  })
  afterEach(() => {
    delete mockLocalStorage['user_cases_v1']
  })

  it('renders save button disabled when no patient selected', () => {
    render(
      <UserCaseManager
        currentPatientId={null}
        currentQuery=""
        currentMode="retrieve"
        currentRecord=""
        onRunCase={() => {}}
      />,
    )
    expect(screen.getByTestId('save-case-btn')).toBeDisabled()
  })

  it('renders save button enabled with patient + query', () => {
    render(
      <UserCaseManager
        currentPatientId="p-001"
        currentQuery="What meds?"
        currentMode="retrieve"
        currentRecord=""
        onRunCase={() => {}}
      />,
    )
    expect(screen.getByTestId('save-case-btn')).not.toBeDisabled()
  })

  it('saves a case and shows it in the list', async () => {
    const user = userEvent.setup()
    render(
      <UserCaseManager
        currentPatientId="p-001"
        currentQuery="What meds?"
        currentMode="retrieve"
        currentRecord=""
        onRunCase={() => {}}
      />,
    )
    await user.click(screen.getByTestId('save-case-btn'))
    await waitFor(() => {
      const stored = JSON.parse(mockLocalStorage['user_cases_v1'] ?? '[]') as unknown[]
      expect(stored).toHaveLength(1)
    })
  })

  it('saved case does NOT appear in aggregateSeededCases result', async () => {
    const { aggregateSeededCases } = await import('@/lib/cases')
    const seeded = [
      {
        id: 'seed-1',
        patientId: 'p001',
        query: 'q',
        mode: 'retrieve' as const,
        referenceLabel: 'ref',
        requiredSections: [],
        rationale: 'r',
      },
    ]

    const before = aggregateSeededCases(seeded)

    const user = userEvent.setup()
    render(
      <UserCaseManager
        currentPatientId="p-xyz"
        currentQuery="Extra user query"
        currentMode="stuff"
        currentRecord="some record"
        onRunCase={() => {}}
      />,
    )
    await user.click(screen.getByTestId('save-case-btn'))

    const after = aggregateSeededCases(seeded)
    expect(after).toEqual(before)
    expect(after.count).toBe(1)
  })
})

describe('useRun stream parsing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
  })

  it('parses text tokens, retrieval data, and eval data from fixture stream', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeReadableStream(FIXTURE_STREAM),
    }))

    const { renderHook } = await import('@testing-library/react')
    const { useRun } = await import('@/hooks/useRun')

    const { result } = renderHook(() => useRun())

    await act(async () => {
      await result.current.run({
        patientId: 'p-test-001',
        query: 'What medications?',
        mode: 'retrieve',
      })
    })

    expect(result.current.text).toBe('The patient takes Lisinopril 10mg daily.')
    expect(result.current.retrieval?.chunks).toHaveLength(1)
    expect(result.current.retrieval?.chunks[0].section).toBe('medications')
    expect(result.current.evalResult?.faithfulness.score).toBe(0.95)
    expect(result.current.evalResult?.sectionHit.scorer).toBe('section-hit')
    expect(result.current.error).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('sets error state when stream contains error data part', async () => {
    const errorStream = `2:[{"type":"error","message":"Token limit exceeded"}]\nd:{"finishReason":"stop","usage":{"promptTokens":1,"completionTokens":0}}`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: makeReadableStream(errorStream),
    }))

    const { renderHook } = await import('@testing-library/react')
    const { useRun } = await import('@/hooks/useRun')

    const { result } = renderHook(() => useRun())

    await act(async () => {
      await result.current.run({
        patientId: 'p-1',
        query: 'q',
        mode: 'retrieve',
      })
    })

    expect(result.current.error).toBe('Token limit exceeded')
  })
})
