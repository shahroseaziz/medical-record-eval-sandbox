import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EvalScorecard } from '../EvalScorecard'
import type { ScorecardAggregate, ScorecardCase } from '../EvalScorecard'

const AGG: ScorecardAggregate = {
  passRate: 0.75,
  judgeReferenceAgreement: 1.0,
  judgeHumanKappa: 0.883,
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

  it('renders judge-reference agreement', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-judge-agreement')).toHaveTextContent('100.0%')
  })

  it('renders Cohen kappa', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-kappa')).toHaveTextContent('0.88')
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

  it('renders honesty note', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-honesty-note')).toHaveTextContent(
      'LLM judge — can be wrong; threshold chosen, not calibrated; human labels are a small proxy set',
    )
  })

  it('renders scope note', () => {
    render(<EvalScorecard aggregate={AGG} cases={CASES} />)
    expect(screen.getByTestId('scorecard-scope-note')).toHaveTextContent(
      'v1 sandbox; custom scorers, full golden-set builder, and cohort RAG are roadmapped',
    )
  })
})
