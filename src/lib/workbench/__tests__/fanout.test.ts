import { describe, it, expect } from 'vitest'
import {
  meteredCallsForCase,
  deterministicFirst,
  scoreSelectionSummary,
} from '@/lib/workbench/fanout'
import type { BenchCaseV4 } from '@/lib/cases'

function benchCase(id: string, fieldScorers: BenchCaseV4['fieldScorers']): BenchCaseV4 {
  return {
    version: 4,
    id,
    taskPrompt: `q-${id}`,
    patientId: `p-${id}`,
    ragMode: 'stuff',
    fieldScorers,
  } as BenchCaseV4
}

describe('meteredCallsForCase (O6b/S23)', () => {
  it('faithfulness books 2 calls (extract + verdict)', () => {
    expect(meteredCallsForCase(benchCase('a', { prose: 'faithfulness' }))).toBe(2)
  })
  it('reference-judge books 1; structured-diff books 0 (free, client-side)', () => {
    expect(meteredCallsForCase(benchCase('b', { prose: 'reference-judge' }))).toBe(1)
    expect(meteredCallsForCase(benchCase('c', { structured: 'structured-diff' }))).toBe(0)
  })
  it('mixed fields sum across the scorer map', () => {
    expect(
      meteredCallsForCase(
        benchCase('d', { structured: 'structured-diff', prose: 'reference-judge' }),
      ),
    ).toBe(1)
  })
  it('an empty scorer map books nothing', () => {
    expect(meteredCallsForCase(benchCase('e', {}))).toBe(0)
  })
})

describe('deterministicFirst (E29c ordering)', () => {
  it('free cases run before metered ones', () => {
    const order = deterministicFirst(['m1', 'f1', 'm2', 'f2'], (s) => (s.startsWith('m') ? 1 : 0))
    expect(order).toEqual(['f1', 'f2', 'm1', 'm2'])
  })
  it('is stable within each class (preserves input order)', () => {
    const order = deterministicFirst([3, 1, 2], () => 0)
    expect(order).toEqual([3, 1, 2])
  })
  it('all-metered input is unchanged', () => {
    expect(deterministicFirst(['a', 'b'], () => 2)).toEqual(['a', 'b'])
  })
})

describe('scoreSelectionSummary (D9 cost preview)', () => {
  const grounding = (c: BenchCaseV4) => 'x'.repeat(c.id === 'big' ? 40_000 : 2_000)
  const cases = [
    benchCase('free', { structured: 'structured-diff' }),
    benchCase('judge', { prose: 'reference-judge' }),
    benchCase('big', { prose: 'faithfulness' }),
  ]

  it('counts only selected cases and their metered calls', () => {
    const s = scoreSelectionSummary(cases, new Set(['free', 'judge']), grounding)
    expect(s.k).toBe(2)
    expect(s.meteredCalls).toBe(1)
    expect(s.estUsd).toBeGreaterThan(0)
  })
  it('an all-free selection estimates zero dollars', () => {
    const s = scoreSelectionSummary(cases, new Set(['free']), grounding)
    expect(s.meteredCalls).toBe(0)
    expect(s.estUsd).toBe(0)
  })
  it('empty selection is zero across the board', () => {
    const s = scoreSelectionSummary(cases, new Set(), grounding)
    expect(s).toEqual({ k: 0, meteredCalls: 0, estUsd: 0 })
  })
  it('cost grows with grounding size (monotone in input tokens)', () => {
    const small = scoreSelectionSummary(cases, new Set(['judge']), grounding)
    const big = scoreSelectionSummary(cases, new Set(['big']), grounding)
    expect(big.estUsd).toBeGreaterThan(small.estUsd)
  })
})
