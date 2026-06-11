import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EvalScorecard } from '../EvalScorecard'
import type { ScorecardAggregate, ScorecardCase } from '../EvalScorecard'

const AGG: ScorecardAggregate = {
  passRate: 0.75,
  judgeReferenceAgreement: 1.0,
  judgeHumanKappa: 0.883,
  interHumanKappa: 0.72,
  n: 4,
}

const CASES: ScorecardCase[] = [
  { id: 'case-pass', label: 'Agustín problems (retrieve)', faithfulnessScore: 1.0, pass: true },
  { id: 'case-fail', label: 'Brenna hallucinated labs (fail)', faithfulnessScore: 0.0, pass: false },
]

describe('EvalScorecard', () => {
  it('renders pass rate from aggregate', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-pass-rate')).toHaveTextContent('75.0%')
  })

  it('renders the seeded agreement as "designed-label agreement" (E26), not clinician copy', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    const agreement = screen.getByTestId('scorecard-judge-agreement')
    expect(agreement).toHaveTextContent('100.0%')
    expect(agreement).toHaveTextContent('Designed-label agreement')
  })

  it('links the "in the open source" claim to the real repository (G7 copy-truth)', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    const link = screen.getByTestId('scorecard-repo-link')
    expect(link).toHaveTextContent('in the open source')
    expect(link).toHaveAttribute('href', expect.stringContaining('github.com/'))
  })

  it('renders the self-preference disclosure (E26)', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-self-preference')).toHaveTextContent('Self-preference')
  })

  it('renders judge-human Cohen kappa', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-kappa-judge-human')).toHaveTextContent('0.88')
  })

  it('renders inter-human Cohen kappa', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-kappa-inter-human')).toHaveTextContent('0.72')
  })

  it('renders N/A for null judge-human kappa', () => {
    render(<EvalScorecard aggregate={{ ...AGG, judgeHumanKappa: null }} cases={CASES} />)
    expect(screen.getByTestId('scorecard-kappa-judge-human')).toHaveTextContent('N/A')
  })

  it('renders N/A for missing inter-human kappa', () => {
    render(<EvalScorecard aggregate={{ ...AGG, interHumanKappa: undefined }} cases={CASES} />)
    expect(screen.getByTestId('scorecard-kappa-inter-human')).toHaveTextContent('N/A')
  })

  it('renders per-case pass row with label, score, and verdict', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    const row = screen.getByTestId('scorecard-case-case-pass')
    expect(row).toHaveTextContent('PASS')
    expect(row).toHaveTextContent('Agustín problems (retrieve)')
    expect(row).toHaveTextContent('1.00')
  })

  it('renders per-case fail row with label, score, and verdict', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    const row = screen.getByTestId('scorecard-case-case-fail')
    expect(row).toHaveTextContent('FAIL')
    expect(row).toHaveTextContent('Brenna hallucinated labs (fail)')
    expect(row).toHaveTextContent('0.00')
  })

  it('renders honesty note mentioning judge mistakes', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-honesty-note')).toHaveTextContent('makes mistakes')
  })

  it('renders scope note with browser-only storage disclosure', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    const note = screen.getByTestId('scorecard-scope-note')
    expect(note).toHaveTextContent('browser only')
    expect(note).toHaveTextContent('accounts')
    expect(note).toHaveTextContent('scorer code')
  })
})
