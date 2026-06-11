import { describe, it, expect } from 'vitest'
import { estimateGenCostUsd, CACHE_READ_MULTIPLIER } from '@/lib/run/cost'

// O6b accept (S23/D8): the cached path's trace estimate is cheaper than the
// uncached path within tolerance — the exact formula /api/run persists, tested
// at the source so a pricing-model regression can't ship silently.
describe('cache-cost: cached path < uncached (D8)', () => {
  const FRESH = { promptTokens: 12_000, completionTokens: 1_000 }

  it('a fully-uncached run costs more than the same tokens served from cache', () => {
    const uncached = estimateGenCostUsd(FRESH)
    // Same total input, but 11k of the prefix served from cache.
    const cached = estimateGenCostUsd({
      promptTokens: 1_000,
      completionTokens: 1_000,
      cacheReadTokens: 11_000,
    })
    expect(cached).toBeLessThan(uncached)
    // The discount is material, not rounding noise: cache reads bill at 0.1×.
    expect(cached).toBeLessThan(uncached * 0.6)
  })

  it('the cache-read leg bills at the documented multiplier', () => {
    const base = estimateGenCostUsd({ promptTokens: 0, completionTokens: 0 })
    const read = estimateGenCostUsd({
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 10_000,
    })
    const full = estimateGenCostUsd({ promptTokens: 10_000, completionTokens: 0 })
    expect(read - base).toBeCloseTo((full - base) * CACHE_READ_MULTIPLIER, 10)
  })

  it('a cache WRITE costs slightly more than fresh input (1.25×) — the first-run premium', () => {
    const fresh = estimateGenCostUsd({ promptTokens: 10_000, completionTokens: 0 })
    const write = estimateGenCostUsd({
      promptTokens: 0,
      completionTokens: 0,
      cacheWriteTokens: 10_000,
    })
    expect(write).toBeGreaterThan(fresh)
    expect(write).toBeLessThan(fresh * 1.3)
  })
})
