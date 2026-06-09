import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// ── localStorage / sessionStorage mocks ──────────────────────────────────────

const mockLocalStorage: Record<string, string> = {}
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (k: string) => mockLocalStorage[k] ?? null,
    setItem: (k: string, v: string) => {
      mockLocalStorage[k] = v
    },
    removeItem: (k: string) => {
      delete mockLocalStorage[k]
    },
    clear: () => {
      Object.keys(mockLocalStorage).forEach((k) => delete mockLocalStorage[k])
    },
  },
  writable: true,
})

Object.defineProperty(window, 'sessionStorage', {
  value: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  },
  writable: true,
})

// ── Component imports (after storage mocks) ───────────────────────────────────

import { GoldenSetBuilder } from '../GoldenSetBuilder'
import type { UserCaseV2, UserCaseV3 } from '@/lib/cases'
import { DEFAULT_PASS_THRESHOLD } from '@/lib/eval/user-agreement'
import type { StoredEvalRun } from '@/lib/eval/user-agreement'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCase(id: string, intentLabel: 'pass' | 'fail' = 'pass'): UserCaseV2 {
  return {
    id,
    taskPrompt: `What medications does patient ${id} take?`,
    patientId: 'patient-001',
    ragMode: 'stuff',
    capturedOutput: `Patient ${id} takes Lisinopril 10mg daily.`,
    capturedGrounding: {
      mode: 'stuff',
      record: `${id}: Lisinopril 10mg daily prescribed for hypertension.`,
    },
    intentLabel,
    provenance: {
      genPromptHash: 'aabbccddeeff0011',
      patientId: 'patient-001',
      ragMode: 'stuff',
    },
    createdAt: 1700000000000,
  }
}

function makeScoreResponse(score: number) {
  return {
    score,
    zeroClaimFlag: false,
    claims: [{ claim: 'Patient takes Lisinopril.', verdict: 'supported', reason: 'stated in record' }],
    groundingSource: 'captured',
  }
}

const DEFAULT_PROPS = {
  runOutput: '',
  retrieval: null,
  currentPatientId: null,
  currentQuery: '',
  currentMode: 'stuff' as const,
  currentRecord: '',
  currentGenPrompt: '',
  runGenPrompt: '',
  loading: false,
  onRunCase: vi.fn(),
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GoldenSetBuilder — runEval with /api/score', () => {
  beforeEach(() => {
    Object.keys(mockLocalStorage).forEach((k) => delete mockLocalStorage[k])
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('N-case run scores all cases sequentially and renders the disagreement table', async () => {
    const user = userEvent.setup()

    const cases = [makeCase('c1', 'pass'), makeCase('c2', 'fail'), makeCase('c3', 'pass')]
    mockLocalStorage['user_cases_v2'] = JSON.stringify(cases)

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeScoreResponse(0.95),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeScoreResponse(0.1),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeScoreResponse(0.9),
      })
    vi.stubGlobal('fetch', fetchMock)

    render(<GoldenSetBuilder {...DEFAULT_PROPS} />)

    // Wait for cases to load from localStorage
    await waitFor(() => {
      expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Run eval (3)')
    })

    await user.click(screen.getByTestId('batch-eval-btn'))

    // Wait for all 3 calls to complete and table to render
    await waitFor(
      () => {
        expect(screen.getByTestId('disagreement-table')).toBeInTheDocument()
      },
      { timeout: 5000 },
    )

    // All 3 cases scored via /api/score
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('/api/score')
      expect(call[1].method).toBe('POST')
      const body = JSON.parse(call[1].body as string)
      expect(body.source).toBe('captured')
      expect(typeof body.capturedOutput).toBe('string')
      expect(typeof body.capturedGrounding).toBe('string')
    }

    // No partial banner — full run
    expect(screen.queryByTestId('partial-run-banner')).not.toBeInTheDocument()

    // Button reverts to "Run eval"
    expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Run eval (3)')
  })

  it('mid-run 429 stops gracefully with partial results and shows resumable message', async () => {
    const user = userEvent.setup()

    const cases = [makeCase('c1', 'pass'), makeCase('c2', 'fail'), makeCase('c3', 'pass')]
    mockLocalStorage['user_cases_v2'] = JSON.stringify(cases)

    const fetchMock = vi
      .fn()
      // c1 succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeScoreResponse(0.95),
      })
      // c2 is rate-limited — run should stop here
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: 'Rate limit exceeded. Max 10 requests per hour per IP.' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    render(<GoldenSetBuilder {...DEFAULT_PROPS} />)

    await waitFor(() => {
      expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Run eval (3)')
    })

    await user.click(screen.getByTestId('batch-eval-btn'))

    // Banner appears after graceful stop
    await waitFor(
      () => {
        expect(screen.getByTestId('partial-run-banner')).toBeInTheDocument()
      },
      { timeout: 5000 },
    )

    const banner = screen.getByTestId('partial-run-banner')
    expect(banner).toHaveTextContent('Rate-limited')
    expect(banner).toHaveTextContent('1 of 3')

    // Partial results render in the table (c1 only)
    expect(screen.getByTestId('disagreement-table')).toBeInTheDocument()

    // c3 was never called — only 2 fetch calls total
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Button offers resume
    expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Resume eval (1/3)')

    // Stored run has partial flag
    const storedRaw = mockLocalStorage['user_eval_run_v1']
    expect(storedRaw).toBeTruthy()
    const stored = JSON.parse(storedRaw) as StoredEvalRun
    expect(stored.partial).toBeDefined()
    expect(stored.partial?.rateLimited).toBe(true)
    expect(stored.partial?.scored).toBe(1)
    expect(stored.partial?.total).toBe(3)
    expect(stored.results).toHaveLength(1)
    expect(stored.results[0].caseId).toBe('c1')
  })

  it('rate-limited on the very first case shows a visible banner with N of M message', async () => {
    const user = userEvent.setup()

    const cases = [makeCase('c1', 'pass'), makeCase('c2', 'fail'), makeCase('c3', 'pass')]
    mockLocalStorage['user_cases_v2'] = JSON.stringify(cases)

    const fetchMock = vi
      .fn()
      // c1 is rate-limited immediately — 0 cases scored
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: 'Rate limit exceeded.' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    render(<GoldenSetBuilder {...DEFAULT_PROPS} />)

    await waitFor(() => {
      expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Run eval (3)')
    })

    await user.click(screen.getByTestId('batch-eval-btn'))

    // Banner must appear even though 0 cases were scored
    await waitFor(
      () => {
        expect(screen.getByTestId('partial-run-banner')).toBeInTheDocument()
      },
      { timeout: 5000 },
    )

    const banner = screen.getByTestId('partial-run-banner')
    expect(banner).toHaveTextContent('Rate-limited')
    expect(banner).toHaveTextContent('0 of 3')

    // Only 1 fetch call — stopped at first case
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Button offers resume
    expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Resume eval (0/3)')

    // Stored run has partial flag with 0 scored
    const storedRaw = mockLocalStorage['user_eval_run_v1']
    expect(storedRaw).toBeTruthy()
    const stored = JSON.parse(storedRaw) as StoredEvalRun
    expect(stored.partial?.rateLimited).toBe(true)
    expect(stored.partial?.scored).toBe(0)
    expect(stored.partial?.total).toBe(3)
    expect(stored.results).toHaveLength(0)
  })

  it('resume run continues from prior partial results without re-scoring completed cases', async () => {
    const user = userEvent.setup()

    const cases = [makeCase('c1', 'pass'), makeCase('c2', 'fail'), makeCase('c3', 'pass')]
    mockLocalStorage['user_cases_v2'] = JSON.stringify(cases)

    // Pre-load partial state — c1 already scored
    const partialRun: StoredEvalRun = {
      timestamp: 1700000000000,
      threshold: DEFAULT_PASS_THRESHOLD,
      results: [
        {
          caseId: 'c1',
          intentLabel: 'pass',
          faithfulnessScore: 0.95,
          zeroClaimFlag: false,
          claims: [{ claim: 'Takes Lisinopril.', verdict: 'supported', rationale: 'stated' }],
          output: 'Patient c1 takes Lisinopril 10mg daily.',
          taskPrompt: 'What medications does patient c1 take?',
        },
      ],
      partial: { scored: 1, total: 3, rateLimited: true },
    }
    mockLocalStorage['user_eval_run_v1'] = JSON.stringify(partialRun)

    // Only c2 and c3 remain
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeScoreResponse(0.1),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makeScoreResponse(0.9),
      })
    vi.stubGlobal('fetch', fetchMock)

    render(<GoldenSetBuilder {...DEFAULT_PROPS} />)

    // Should load partial state and show Resume button
    await waitFor(() => {
      expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Resume eval (1/3)')
    })

    await user.click(screen.getByTestId('batch-eval-btn'))

    // Wait for completion
    await waitFor(
      () => {
        expect(screen.queryByTestId('partial-run-banner')).not.toBeInTheDocument()
      },
      { timeout: 5000 },
    )

    // Only 2 fetch calls (c1 skipped, c2+c3 scored)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Full table with all 3 rows
    expect(screen.getByTestId('disagreement-table')).toBeInTheDocument()

    // Final stored run has no partial flag
    const finalStored = JSON.parse(mockLocalStorage['user_eval_run_v1']) as StoredEvalRun
    expect(finalStored.partial).toBeUndefined()
    expect(finalStored.results).toHaveLength(3)

    // Button back to "Run eval"
    expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Run eval (3)')
  })
})

// ── Per-field scorer dispatch (mixed diff + judge row) ────────────────────────

function makeV3MixedCase(id: string, intentLabel: 'pass' | 'fail' = 'pass'): UserCaseV3 {
  const meds = { medications: [{ name: 'Lisinopril', dose: '10mg' }] }
  return {
    version: 3,
    id,
    taskPrompt: `What medications does patient ${id} take?`,
    patientId: 'patient-001',
    ragMode: 'stuff',
    // Captured output is structured JSON so structured-diff can parse it.
    capturedOutput: JSON.stringify(meds),
    capturedGrounding: { mode: 'stuff', record: `${id}: Lisinopril 10mg daily.` },
    expectedStructured: meds,
    expectedProse: `${id} takes Lisinopril 10mg daily.`,
    // structured field graded by the deterministic diff; prose by the reference judge.
    fieldScorers: { structured: 'structured-diff', prose: 'reference-judge' },
    intentLabel,
    provenance: {
      genPromptHash: 'aabbccddeeff0011',
      patientId: 'patient-001',
      ragMode: 'stuff',
    },
    createdAt: 1700000000000,
  }
}

describe('GoldenSetBuilder — per-field scorer dispatch', () => {
  beforeEach(() => {
    Object.keys(mockLocalStorage).forEach((k) => delete mockLocalStorage[k])
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dispatches reference-judge to /api/score-reference and composes a mixed diff+judge row', async () => {
    const user = userEvent.setup()

    mockLocalStorage['user_cases_v3'] = JSON.stringify([makeV3MixedCase('c1', 'pass')])

    // Only the reference-judge field hits the network — structured-diff is
    // deterministic and runs client-side, so exactly one fetch is expected.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        score: 0.9,
        verdict: 'equivalent',
        reason: 'same meaning',
        threshold: 0.8,
        passed: true,
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<GoldenSetBuilder {...DEFAULT_PROPS} />)

    await waitFor(() => {
      expect(screen.getByTestId('batch-eval-btn')).toHaveTextContent('Run eval (1)')
    })

    await user.click(screen.getByTestId('batch-eval-btn'))

    await waitFor(
      () => {
        expect(screen.getByTestId('disagreement-table')).toBeInTheDocument()
      },
      { timeout: 5000 },
    )

    // Reference judge dispatched to the R5 route — NOT faithfulness /api/score.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/score-reference')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(typeof body.actual).toBe('string')
    expect(typeof body.expected).toBe('string')

    // The mixed row scored cleanly (structured-diff 1.0 + reference-judge 0.9) and
    // renders a verdict — designed-pass + both fields matched → agreement (no
    // disagreement highlight).
    const row = screen.getByTestId('disagreement-row-c1')
    expect(row).toHaveAttribute('data-disagrees', 'false')
  })
})
