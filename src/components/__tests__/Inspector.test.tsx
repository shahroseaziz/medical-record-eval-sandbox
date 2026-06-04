import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Inspector } from '../Inspector'
import type { RunTrace } from '@/app/api/run/types'

const FIXTURE_TRACE: RunTrace = {
  caseId: 'test-case-1',
  ragMode: 'retrieve',
  retrieval: {
    chunks: [
      { section: 'medications', text: 'Lisinopril 10mg daily for hypertension', distance: 0.12, similarity: 0.88 },
      { section: 'allergies', text: 'Penicillin: severe reaction (anaphylaxis)', distance: 0.18, similarity: 0.82 },
    ],
    groundingContext: '[medications]\nLisinopril 10mg daily\n\n[allergies]\nPenicillin allergy',
    assembledPrompt: 'Based on the medical record, answer: What medications?',
  },
  sectionHit: {
    scorer: 'section-hit',
    score: 1,
    requiredSections: ['medications', 'allergies'],
    retrievedSections: ['medications', 'allergies'],
    missingSections: [],
  },
  output: 'The patient takes Lisinopril 10mg daily.',
  scorerResults: [
    {
      scorer: 'faithfulness',
      score: 0.95,
      claims: [
        {
          claim: 'Patient takes Lisinopril 10mg daily',
          verdict: 'supported',
          rationale: 'Explicitly stated in the medications section',
        },
      ],
      extractPrompt: 'Extract all factual claims from the following response.',
      verdictPrompt: 'Verify each claim against the provided medical record context.',
    },
    {
      scorer: 'section-hit',
      score: 1,
      requiredSections: ['medications', 'allergies'],
      retrievedSections: ['medications', 'allergies'],
      missingSections: [],
    },
  ],
  generationModel: 'claude-haiku-4-5-20251001',
  judgeModel: 'claude-haiku-4-5-20251001',
  embeddingModel: 'voyage-3-5',
  inputType: 'query',
  tokens: { input: 120, output: 15, estCostUsd: 0.00012 },
  claimCount: 1,
  outputLength: 40,
  judgeUsesByo: false,
}

describe('Inspector', () => {
  it('renders chunks with distance and similarity', () => {
    render(<Inspector trace={FIXTURE_TRACE} />)

    expect(screen.getByTestId('chunk-0')).toBeInTheDocument()
    expect(screen.getByTestId('chunk-0-distance')).toHaveTextContent('0.1200')
    expect(screen.getByTestId('chunk-0-similarity')).toHaveTextContent('0.8800')

    expect(screen.getByTestId('chunk-1')).toBeInTheDocument()
    expect(screen.getByTestId('chunk-1-distance')).toHaveTextContent('0.1800')
    expect(screen.getByTestId('chunk-1-similarity')).toHaveTextContent('0.8200')
  })

  it('renders "X of Y sections" summary', () => {
    render(<Inspector trace={FIXTURE_TRACE} />)
    expect(screen.getByTestId('chunks-summary')).toHaveTextContent('retrieved 2 of 2 sections')
  })

  it('renders assembled prompt', () => {
    render(<Inspector trace={FIXTURE_TRACE} />)
    expect(screen.getByTestId('assembled-prompt')).toHaveTextContent(
      'Based on the medical record, answer: What medications?',
    )
  })

  it('renders judge extract and verdict prompts', () => {
    render(<Inspector trace={FIXTURE_TRACE} />)
    expect(screen.getByTestId('extract-prompt')).toHaveTextContent(
      'Extract all factual claims from the following response.',
    )
    expect(screen.getByTestId('verdict-prompt')).toHaveTextContent(
      'Verify each claim against the provided medical record context.',
    )
  })

  it('renders claim rationale', () => {
    render(<Inspector trace={FIXTURE_TRACE} />)
    expect(screen.getByTestId('rationale-0')).toHaveTextContent(
      'Explicitly stated in the medications section',
    )
  })

  it('renders section_hit indicator', () => {
    render(<Inspector trace={FIXTURE_TRACE} />)
    expect(screen.getByTestId('section-hit')).toHaveTextContent('section_hit:')
    expect(screen.getByTestId('section-hit')).toHaveTextContent('✓')
  })

  it('renders baseline mean ± stddev when baselineEntry provided', () => {
    render(<Inspector trace={FIXTURE_TRACE} baselineEntry={{ meanScore: 0.9, scoreStdDev: 0.03 }} />)
    const el = screen.getByTestId('baseline-entry')
    expect(el).toHaveTextContent('0.90')
    expect(el).toHaveTextContent('0.03')
  })

  it('does not render baseline entry when prop is absent', () => {
    render(<Inspector trace={FIXTURE_TRACE} />)
    expect(screen.queryByTestId('baseline-entry')).not.toBeInTheDocument()
  })
})
