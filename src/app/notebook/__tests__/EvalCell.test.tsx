import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { EvalCell } from '../EvalCell'
import { JUDGE_MODEL, modelDisplayName } from '@/lib/models'
import type { OutputCardResult } from '../useNotebookRun'
import type { NotebookPatient } from '../types'

// SHA-161 N9 — golden-answer eval cell. No-chooser invite → per-patient golden
// editors → CLIENT-SIDE deterministic scoring via lib/eval/normalize. The final
// test asserts ZERO network calls fire while scoring (collateral guard).

function patient(id: string, name: string): NotebookPatient {
  return { id, name, record: '', recordTokens: 0, age: 60, sex: 'F', conditionCount: 3 }
}

function doneResult(id: string, output: string): OutputCardResult {
  return { patientId: id, status: 'done', output, model: 'claude-haiku-4-5-20251001', context: null }
}

const MODEL_OUT = JSON.stringify({
  a1c_current: 6.7,
  a1c_trend: 'improving',
  diabetes_meds: ['Metformin', 'Glipizide'],
})

function renderCell(opts?: { order?: string[]; results?: Record<string, OutputCardResult> }) {
  const order = opts?.order ?? ['p1', 'p2']
  const results =
    opts?.results ??
    ({ p1: doneResult('p1', MODEL_OUT), p2: doneResult('p2', MODEL_OUT) } as Record<
      string,
      OutputCardResult
    >)
  const patientsById = new Map<string, NotebookPatient>([
    ['p1', patient('p1', 'Ada Lovelace')],
    ['p2', patient('p2', 'Alan Turing')],
  ])
  const onViewChart = vi.fn()
  render(
    <EvalCell
      order={order}
      results={results}
      patientsById={patientsById}
      onViewChart={onViewChart}
    />,
  )
  return { onViewChart }
}

describe('EvalCell — invite (no chooser)', () => {
  it('offers a primary "Add golden answers" and a quieter "or use an LLM judge" link — no radio/chooser', () => {
    renderCell()
    const invite = screen.getByTestId('eval-invite')
    expect(within(invite).getByTestId('golden-invite-add')).toHaveTextContent(/add golden answers/i)
    expect(within(invite).getByTestId('golden-invite-judge')).toHaveTextContent(/llm judge/i)
    // No-chooser: there is no radio group in the invite.
    expect(invite.querySelector('input[type="radio"]')).toBeNull()
  })

  it('stays quiet (no invite) until there is model output to grade', () => {
    renderCell({ order: [], results: {} })
    expect(screen.queryByTestId('eval-invite')).not.toBeInTheDocument()
    expect(screen.getByTestId('section-eval')).toBeInTheDocument()
  })

  it('the judge link reveals the LLM-judge cell with a criteria box (N10)', async () => {
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-judge'))
    expect(screen.getByTestId('judge-criteria')).toBeInTheDocument()
  })
})

describe('EvalCell — golden editors', () => {
  it('shows a per-patient editor with an open-chart link and the chart-not-output nudge', async () => {
    const user = userEvent.setup()
    const { onViewChart } = renderCell()
    await user.click(screen.getByTestId('golden-invite-add'))

    const editors = screen.getAllByTestId('golden-editor')
    expect(editors).toHaveLength(2)
    expect(editors[0]).toHaveAttribute('data-patient-id', 'p1')
    expect(within(editors[0]).getByText('Ada Lovelace')).toBeInTheDocument()

    // The "grade the chart, not the output" nudge is present.
    expect(screen.getByTestId('golden-nudge')).toHaveTextContent(/grade the chart, not the output/i)

    // The open-chart link is live (beside the editor).
    await user.click(within(editors[0]).getByTestId('golden-open-chart'))
    expect(onViewChart).toHaveBeenCalledWith('p1')
  })

  it('passes a patient when every golden field matches after normalization', async () => {
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-add'))

    // A golden with a SIG alias + reordered list — both folded by normalize.ts.
    const golden = JSON.stringify({
      a1c_trend: 'improving',
      diabetes_meds: ['Glipizide', 'Metformin'],
    })
    const inputs = screen.getAllByTestId('golden-input')
    await user.click(inputs[0])
    await user.paste(golden)
    await user.click(screen.getByTestId('golden-score'))

    const editor = screen.getAllByTestId('golden-editor')[0]
    expect(within(editor).getByTestId('golden-verdict')).toHaveAttribute('data-verdict', 'pass')
  })

  it('a failing field shows a ≠ chip that expands to an expected-vs-got diff', async () => {
    const user = userEvent.setup()
    renderCell({ order: ['p1'], results: { p1: doneResult('p1', MODEL_OUT) } })
    await user.click(screen.getByTestId('golden-invite-add'))

    await user.click(screen.getByTestId('golden-input'))
    await user.paste(JSON.stringify({ a1c_current: 5.9 }))
    await user.click(screen.getByTestId('golden-score'))

    const chip = screen.getByTestId('golden-fail-chip')
    expect(chip).toHaveTextContent('a1c_current')
    expect(screen.queryByTestId('golden-diff')).not.toBeInTheDocument()

    await user.click(chip)
    const diff = screen.getByTestId('golden-diff')
    expect(diff).toHaveTextContent('5.9') // expected (golden)
    expect(diff).toHaveTextContent('6.7') // got (model)
  })

  it('grades partially — a field absent from the golden is not graded', async () => {
    const user = userEvent.setup()
    renderCell({ order: ['p1'], results: { p1: doneResult('p1', MODEL_OUT) } })
    await user.click(screen.getByTestId('golden-invite-add'))

    // Only asserts a1c_current (correct); the rest of the output is ungraded.
    await user.click(screen.getByTestId('golden-input'))
    await user.paste(JSON.stringify({ a1c_current: 6.7 }))
    await user.click(screen.getByTestId('golden-score'))

    expect(screen.getByTestId('golden-verdict')).toHaveAttribute('data-verdict', 'pass')
    expect(screen.getByTestId('golden-overall')).toHaveTextContent('1/1')
  })

  // N11 — the golden Score lifts a cube-shaped row up so the score line can
  // project it. The cell does not render the trail itself.
  it('lifts a golden score row up via onScoreReport (cube-shaped, for the score line)', async () => {
    const user = userEvent.setup()
    const onScoreReport = vi.fn()
    const patientsById = new Map<string, NotebookPatient>([['p1', patient('p1', 'Ada')]])
    render(
      <EvalCell
        order={['p1']}
        results={{ p1: doneResult('p1', MODEL_OUT) }}
        patientsById={patientsById}
        onViewChart={vi.fn()}
        onScoreReport={onScoreReport}
      />,
    )
    await user.click(screen.getByTestId('golden-invite-add'))
    await user.click(screen.getByTestId('golden-input'))
    await user.paste(JSON.stringify({ a1c_current: 6.7 }))
    await user.click(screen.getByTestId('golden-score'))

    expect(onScoreReport).toHaveBeenCalledTimes(1)
    const report = onScoreReport.mock.calls[0][0]
    expect(report.evalKey).toBe('golden')
    expect(report.row.frac).toBe('1/1')
    expect(report.row.per).toEqual([{ patientId: 'p1', pass: true, fails: [] }])
  })
})

describe('EvalCell — LLM judge (N10)', () => {
  // A fetch stub that returns a queued {pass, reason} body (or an error status)
  // per call, so a sequential judge run can be driven deterministically.
  function stubScore(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
    let i = 0
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      return {
        ok: r.ok,
        status: r.status ?? (r.ok ? 200 : 503),
        json: async () => r.body,
      } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function openJudge() {
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-judge'))
    return user
  }

  it('shows a criteria box with the worked-example placeholder', async () => {
    await openJudge()
    const box = screen.getByTestId('judge-criteria')
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('Pass if a1c_current'))
  })

  it('ships the DECISION D1 binary copy — no "partial" verdict state', async () => {
    await openJudge()
    const note = screen.getByTestId('judge-binary-note')
    expect(note).toHaveTextContent(/single pass or fail/i)
    expect(note).toHaveTextContent(/no partial credit|conservatively/i)
    // No "partial" verdict ever rendered.
    expect(screen.queryByText(/partial/i, { selector: '[data-verdict]' })).toBeNull()
  })

  it('makes EXACTLY one metered call per patient and renders {pass, reason} per patient', async () => {
    const fetchMock = stubScore([
      { ok: true, body: { pass: true, reason: 'Matches the chart on every field.' } },
      { ok: true, body: { pass: false, reason: 'The A1c value is stale.' } },
    ])
    const user = await openJudge()

    await user.click(screen.getByTestId('judge-criteria'))
    await user.paste('Pass if the A1c is current.')
    await user.click(screen.getByTestId('judge-run'))

    await waitFor(() => expect(screen.getByTestId('judge-overall')).toBeInTheDocument())

    // EXACTLY one call per patient (two patients → two calls), all to the criteria contract.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('/api/score')
      const body = JSON.parse((call[1] as RequestInit).body as string)
      expect(body.source).toBe('criteria')
    }

    const verdicts = screen.getAllByTestId('judge-verdict')
    expect(verdicts).toHaveLength(2)
    expect(verdicts[0]).toHaveAttribute('data-verdict', 'pass')
    expect(verdicts[0]).toHaveTextContent('Matches the chart on every field.')
    expect(verdicts[1]).toHaveAttribute('data-verdict', 'fail')
    expect(verdicts[1]).toHaveTextContent('The A1c value is stale.')
  })

  it('stamps the producing judge model id on each verdict', async () => {
    stubScore([
      { ok: true, body: { pass: true, reason: 'ok' } },
      { ok: true, body: { pass: false, reason: 'no' } },
    ])
    const user = await openJudge()
    await user.click(screen.getByTestId('judge-criteria'))
    await user.paste('Pass if correct.')
    await user.click(screen.getByTestId('judge-run'))

    await waitFor(() => expect(screen.getAllByTestId('judge-verdict')).toHaveLength(2))
    const stamps = screen.getAllByTestId('judge-model-stamp')
    expect(stamps).toHaveLength(2)
    for (const s of stamps) {
      expect(s).toHaveTextContent(`judged by ${modelDisplayName(JUDGE_MODEL)}`)
    }
  })

  it('EXCLUDES a judge-errored patient from the denominator with the exact "couldn\'t grade" copy', async () => {
    // p1 passes; p2's judge call fails → excluded from the score, not a fail.
    stubScore([
      { ok: true, body: { pass: true, reason: 'Matches.' } },
      { ok: false, status: 503, body: { error: 'Judge unavailable.' } },
    ])
    const user = await openJudge()
    await user.click(screen.getByTestId('judge-criteria'))
    await user.paste('Pass if correct.')
    await user.click(screen.getByTestId('judge-run'))

    await waitFor(() => expect(screen.getByTestId('judge-overall')).toBeInTheDocument())

    // Exact design copy on the errored row.
    const errored = screen.getByTestId('judge-verdict-errored')
    expect(errored).toHaveTextContent("couldn't grade — excluded from the score")

    // Exclusion arithmetic: denominator is 1 (only the scored patient), not 2.
    const overall = screen.getByTestId('judge-overall')
    expect(overall).toHaveTextContent('1/1')
    expect(overall).toHaveTextContent(/1 couldn't grade — excluded from the score/i)
  })

  it('never fabricates a reason on a judge error', async () => {
    // Every call errors (the stub returns the error body for all patients).
    stubScore([{ ok: false, status: 503, body: { error: 'Judge unavailable.' } }])
    const user = await openJudge()
    await user.click(screen.getByTestId('judge-criteria'))
    await user.paste('Pass if correct.')
    await user.click(screen.getByTestId('judge-run'))

    await waitFor(() => expect(screen.getAllByTestId('judge-verdict-errored').length).toBeGreaterThan(0))
    const errored = screen.getAllByTestId('judge-verdict-errored')[0]
    // The error message comes through; the judge's "reason" paragraph is never invented.
    expect(errored).toHaveTextContent(/judge call failed/i)
    // An errored row is excluded — it is NOT rendered as a fail verdict.
    expect(errored).toHaveAttribute('data-verdict', 'errored')
    expect(screen.queryByTestId('judge-verdict')).toBeNull()
  })
})

describe('EvalCell — do-you-agree thumbs + derived lines (N17)', () => {
  function stubScore(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
    let i = 0
    const fetchMock = vi.fn(async () => {
      const r = responses[Math.min(i, responses.length - 1)]
      i += 1
      return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 503), json: async () => r.body } as Response
    })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function runJudge(responses: Array<{ ok: boolean; status?: number; body: unknown }>) {
    const fetchMock = stubScore(responses)
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-judge'))
    await user.click(screen.getByTestId('judge-criteria'))
    await user.paste('Pass if the A1c is current.')
    await user.click(screen.getByTestId('judge-run'))
    await waitFor(() => expect(screen.getAllByTestId('judge-verdict')).toHaveLength(2))
    return { user, fetchMock }
  }

  it('puts agree/disagree thumbs on judge rows only — golden rows carry none', async () => {
    const { user } = await runJudge([
      { ok: true, body: { pass: true, reason: 'ok' } },
      { ok: true, body: { pass: false, reason: 'no' } },
    ])
    // Both judge rows carry the thumbs.
    expect(screen.getAllByTestId('agree-thumbs')).toHaveLength(2)

    // Switch to golden answers — those rows have NO thumbs.
    await user.click(screen.getByTestId('judge-switch-golden'))
    const editors = screen.getAllByTestId('golden-editor')
    expect(editors).toHaveLength(2)
    for (const ed of editors) {
      expect(within(ed).queryByTestId('agree-thumbs')).toBeNull()
    }
  })

  it('"you: a/m" uses the of-MARKED denominator, never of-scored', async () => {
    const { user } = await runJudge([
      { ok: true, body: { pass: true, reason: 'ok' } },
      { ok: true, body: { pass: true, reason: 'ok' } },
    ])
    // Two scored verdicts; mark only ONE (agree on p1).
    const rows = screen.getAllByTestId('judge-verdict')
    await user.click(within(rows[0]).getByTestId('agree-yes'))
    expect(within(rows[0]).getByTestId('agree-yes')).toHaveAttribute('data-on', 'true')

    const line = screen.getByTestId('judge-you-vs')
    // of-MARKED: 1 agreed of 1 marked …
    expect(line).toHaveTextContent('you: 1/1')
    // … and NOT the of-scored denominator of 2 (the known bug).
    expect(line).not.toHaveTextContent('/2')
  })

  it('counts a disagree toward the marked denominator but not the agreed count', async () => {
    const { user } = await runJudge([
      { ok: true, body: { pass: true, reason: 'ok' } },
      { ok: true, body: { pass: false, reason: 'no' } },
    ])
    const rows = screen.getAllByTestId('judge-verdict')
    await user.click(within(rows[0]).getByTestId('agree-yes'))
    await user.click(within(rows[1]).getByTestId('agree-no'))
    expect(screen.getByTestId('judge-you-vs')).toHaveTextContent('you: 1/2')
  })

  it('never folds the thumbs into the judge pass count', async () => {
    const { user } = await runJudge([
      { ok: true, body: { pass: true, reason: 'ok' } },
      { ok: true, body: { pass: true, reason: 'ok' } },
    ])
    // Disagree with BOTH passes — the verdict count must stay 2/2.
    const rows = screen.getAllByTestId('judge-verdict')
    await user.click(within(rows[0]).getByTestId('agree-no'))
    await user.click(within(rows[1]).getByTestId('agree-no'))
    expect(screen.getByTestId('judge-overall')).toHaveTextContent('2/2')
  })

  it('re-pressing a thumb clears the mark (the line drops)', async () => {
    const { user } = await runJudge([
      { ok: true, body: { pass: true, reason: 'ok' } },
      { ok: true, body: { pass: true, reason: 'ok' } },
    ])
    const row = screen.getAllByTestId('judge-verdict')[0]
    await user.click(within(row).getByTestId('agree-yes'))
    expect(screen.getByTestId('judge-you-vs')).toHaveTextContent('you: 1/1')
    await user.click(within(row).getByTestId('agree-yes'))
    expect(screen.queryByTestId('judge-you-vs')).toBeNull()
  })

  it('computes "judge-vs-golden m of n" from the overlap, with lead-not-verdict copy and no extra calls', async () => {
    const user = userEvent.setup()
    renderCell()

    // 1) Score a golden first: p1 matches the model (pass), p2 does not (fail).
    await user.click(screen.getByTestId('golden-invite-add'))
    const inputs = screen.getAllByTestId('golden-input')
    await user.click(inputs[0])
    await user.paste(JSON.stringify({ a1c_current: 6.7 }))
    await user.click(inputs[1])
    await user.paste(JSON.stringify({ a1c_current: 5.9 }))
    await user.click(screen.getByTestId('golden-score'))

    // 2) Switch to the judge and run it — both patients pass per the stub.
    const fetchMock = stubScore([
      { ok: true, body: { pass: true, reason: 'ok' } },
      { ok: true, body: { pass: true, reason: 'ok' } },
    ])
    await user.click(screen.getByTestId('golden-switch-judge'))
    await user.click(screen.getByTestId('judge-criteria'))
    await user.paste('Pass if the A1c is current.')
    await user.click(screen.getByTestId('judge-run'))
    await waitFor(() => expect(screen.getAllByTestId('judge-verdict')).toHaveLength(2))

    // Overlap = 2 (both scored by judge AND golden); match = 1 (p1 pass/pass; p2 fail/pass).
    const line = screen.getByTestId('judge-vs-golden')
    expect(line).toHaveTextContent('1 of 2')
    expect(line).toHaveTextContent(/lead, not a verdict/i)

    // The derived line is pure client-side: only the two judge calls fired, nothing more.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('EvalCell — ZERO metered calls during scoring (collateral guard)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scoring a golden fires no network / score call — it is purely client-side', async () => {
    const user = userEvent.setup()
    renderCell()
    await user.click(screen.getByTestId('golden-invite-add'))

    const inputs = screen.getAllByTestId('golden-input')
    await user.click(inputs[0])
    await user.paste(JSON.stringify({ a1c_current: 6.7 }))
    await user.click(screen.getByTestId('golden-score'))

    // The verdict rendered (proof scoring ran) …
    expect(screen.getByTestId('golden-overall')).toBeInTheDocument()
    // … and not a single fetch was made.
    expect(fetch).not.toHaveBeenCalled()
  })
})
