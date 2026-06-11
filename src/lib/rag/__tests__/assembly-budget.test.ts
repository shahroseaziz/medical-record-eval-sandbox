import { describe, it, expect } from 'vitest'
import { fitChunksToBudget, type RetrievedChunk } from '../index'
import { estimateInputTokens } from '../../tokens'

// SHA-78 / arch S25 (SHA-75 fix): retrieve-mode assembly bounds by token COUNT,
// not k alone. fitChunksToBudget appends chunks in relevance order until the next
// one would exceed the input budget, then stops. Partial sets are valid.

function chunk(section: string, text: string): RetrievedChunk {
  return { section, text, distance: 0.1, similarity: 0.9 }
}

// Grounding renderer mirroring the run route's buildGroundingContext('retrieve', …).
const render = (cs: RetrievedChunk[]) => cs.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')

describe('fitChunksToBudget()', () => {
  it('keeps every chunk when they all fit the budget', () => {
    const chunks = [chunk('a', 'short'), chunk('b', 'also short')]
    const result = fitChunksToBudget(chunks, 12_000, 100, render)
    expect(result.inBudgetCount).toBe(2)
    expect(result.retrievedCount).toBe(2)
    expect(result.chunks).toHaveLength(2)
  })

  it('stops appending once the budget is reached — partial set is valid', () => {
    // Three ~1000-char chunks (~520 tokens each). Budget leaves room for ~2.
    const big = 'x'.repeat(1_000)
    const chunks = [chunk('a', big), chunk('b', big), chunk('c', big)]
    const perChunk = estimateInputTokens(render([chunk('a', big)]))
    const overhead = 100
    const budget = overhead + perChunk * 2 + 5 // room for 2, not 3

    const result = fitChunksToBudget(chunks, budget, overhead, render)
    expect(result.retrievedCount).toBe(3)
    expect(result.inBudgetCount).toBe(2)
    expect(result.chunks.map((c) => c.section)).toEqual(['a', 'b'])
  })

  it('preserves relevance order (does not reorder to maximise packing)', () => {
    const huge = 'x'.repeat(4_000)
    const small = 'tiny'
    // Most-relevant chunk is huge and alone exhausts the budget; a later small
    // chunk must NOT be promoted ahead of it.
    const chunks = [chunk('first', huge), chunk('second', small)]
    const overhead = 100
    const budget = overhead + estimateInputTokens(render([chunk('first', huge)])) - 50

    const result = fitChunksToBudget(chunks, budget, overhead, render)
    expect(result.inBudgetCount).toBe(0)
  })

  it('returns zero in-budget when even the first chunk overflows (named-error precondition)', () => {
    const chunks = [chunk('a', 'x'.repeat(50_000))]
    const result = fitChunksToBudget(chunks, 12_000, 100, render)
    expect(result.retrievedCount).toBe(1)
    expect(result.inBudgetCount).toBe(0)
    expect(result.chunks).toHaveLength(0)
  })

  it('accounts for fixed overhead (system prompt + query) against the budget', () => {
    const c = chunk('a', 'x'.repeat(1_000))
    const groundingTokens = estimateInputTokens(render([c]))
    // Budget that would fit the chunk with no overhead, but not once overhead
    // consumes most of it.
    const budget = groundingTokens + 10
    const overhead = 50
    expect(fitChunksToBudget([c], budget, 0, render).inBudgetCount).toBe(1)
    expect(fitChunksToBudget([c], budget, overhead, render).inBudgetCount).toBe(0)
  })

  it('handles an empty retrieval set', () => {
    const result = fitChunksToBudget([], 12_000, 100, render)
    expect(result.retrievedCount).toBe(0)
    expect(result.inBudgetCount).toBe(0)
  })
})
