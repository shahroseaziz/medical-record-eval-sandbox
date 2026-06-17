import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WorkedExampleReplay, WorkedExampleSection } from '../WorkedExampleReplay'
import {
  EXAMPLE_SCHEMA_VERSION,
  type NotebookExampleArtifact,
} from '../example-artifact'

// N13b — the `?example=1` replay surface. Rendered against a SYNTHETIC artifact
// (the real one is a maintainer-committed fixture), this proves BOTH legs render
// fully — a golden result and judge verdicts — with no engine and no network.

const MODEL = 'claude-haiku-4-5-20251001'

function artifact(): NotebookExampleArtifact {
  const passVal = { a1c_current: 6.7, diabetes_meds: ['Metformin 500 MG'] }
  return {
    schemaVersion: EXAMPLE_SCHEMA_VERSION,
    description: 'stub',
    generatedAt: '2026-06-17T00:00:00.000Z',
    models: { generation: MODEL, judge: MODEL },
    golden: {
      prompt: 'Extract diabetes management as JSON.',
      cases: [
        {
          patientId: 'p-pass',
          patientName: 'Ada Pass',
          output: JSON.stringify(passVal),
          model: MODEL,
          golden: JSON.stringify(passVal),
        },
        {
          patientId: 'p-fail',
          patientName: 'Ben Fail',
          output: JSON.stringify({ a1c_current: 6.7 }),
          model: MODEL,
          golden: JSON.stringify({ a1c_current: 8.1, diabetes_meds: ['Metformin 500 MG'] }),
        },
      ],
    },
    judge: {
      prompt: 'Write a two-sentence summary.',
      criteria: 'Pass if the summary cites the A1c trend.',
      cases: [
        {
          patientId: 'p-pass',
          patientName: 'Ada Pass',
          output: 'A grounded summary.',
          model: MODEL,
          verdict: { errored: false, pass: true, reason: 'Cites the trend.' },
          judgeModel: MODEL,
        },
        {
          patientId: 'p-err',
          patientName: 'Cleo Errored',
          output: 'Another summary.',
          model: MODEL,
          verdict: { errored: true },
          judgeModel: null,
        },
      ],
    },
  }
}

describe('WorkedExampleReplay — both legs render fully', () => {
  it('renders the zero-API-calls banner and the start-your-own-run link', () => {
    render(<WorkedExampleReplay artifact={artifact()} />)
    expect(screen.getByTestId('example-banner')).toHaveTextContent(/no API calls/i)
    expect(screen.getByTestId('example-start-own')).toHaveAttribute('href', '/notebook')
  })

  it('renders the GOLDEN leg: output cards + a pass and a recomputed fail', () => {
    render(<WorkedExampleReplay artifact={artifact()} />)
    expect(screen.getByTestId('example-golden-leg')).toBeInTheDocument()
    // One done output card per golden patient.
    expect(screen.getAllByTestId('output-card').length).toBeGreaterThanOrEqual(2)
    const rows = screen.getAllByTestId('example-golden-row')
    expect(rows).toHaveLength(2)
    expect(screen.getByTestId('example-golden-verdict')).toHaveAttribute('data-verdict', 'pass')
    expect(screen.getByTestId('example-golden-fail-chip')).toHaveAttribute('data-verdict', 'fail')
  })

  it('renders the JUDGE leg: a settled verdict + the errored (not scored) verdict', () => {
    render(<WorkedExampleReplay artifact={artifact()} />)
    expect(screen.getByTestId('example-judge-criteria')).toHaveTextContent(/A1c trend/i)
    // A real binary verdict and the errored "couldn't grade" state — never fabricated.
    expect(screen.getByTestId('judge-verdict')).toHaveAttribute('data-verdict', 'pass')
    expect(screen.getByTestId('judge-verdict-errored')).toBeInTheDocument()
    // The overall counts only the scored patient (the errored one is excluded).
    expect(screen.getByTestId('judge-overall')).toHaveTextContent('1/1')
  })
})

describe('WorkedExampleSection — loader states', () => {
  it('renders the replay when ready', () => {
    render(<WorkedExampleSection status="ready" artifact={artifact()} message={null} />)
    expect(screen.getByTestId('worked-example-replay')).toBeInTheDocument()
  })

  it('shows a loading placeholder while fetching', () => {
    render(<WorkedExampleSection status="loading" artifact={null} message={null} />)
    expect(screen.getByTestId('example-loading')).toBeInTheDocument()
  })

  it('shows an honest "not published yet" state when the artifact is absent', () => {
    render(<WorkedExampleSection status="unavailable" artifact={null} message={null} />)
    expect(screen.getByTestId('example-unavailable')).toHaveTextContent(/not been published yet/i)
    expect(screen.getByTestId('example-start-own')).toHaveAttribute('href', '/notebook')
  })

  it('surfaces an error message on a failed load', () => {
    render(<WorkedExampleSection status="error" artifact={null} message="boom" />)
    expect(screen.getByTestId('example-unavailable')).toHaveTextContent('boom')
  })
})
