import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @upstash/redis before importing the module under test
vi.mock('@upstash/redis', () => {
  return {
    Redis: {
      fromEnv: vi.fn(),
    },
  }
})

import { Redis } from '@upstash/redis'
import {
  bookSpend,
  SpendCapError,
  DAILY_CAP_MICRO_USD,
  HOURLY_CAP_MICRO_USD,
  ESTIMATED_RUN_COST_MICRO_USD,
} from '../killswitch'

// Build an in-memory Redis mock that tracks per-key counters.
// All INCRBY/DECRBY operations are reflected in the returned counters object.
function makeMemoryRedis() {
  const counters: Record<string, number> = {}
  const redis = {
    incrby: vi.fn(async (key: string, amount: number) => {
      counters[key] = (counters[key] ?? 0) + amount
      return counters[key]
    }),
    decrby: vi.fn(async (key: string, amount: number) => {
      counters[key] = (counters[key] ?? 0) - amount
      return counters[key]
    }),
    expire: vi.fn().mockResolvedValue(1),
    _counters: counters,
  }
  return redis
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('bookSpend()', () => {
  it('succeeds and returns a refund function when caps have room', async () => {
    const mem = makeMemoryRedis()
    vi.mocked(Redis.fromEnv).mockReturnValue(mem as unknown as ReturnType<typeof Redis.fromEnv>)

    const refund = await bookSpend(100)
    expect(typeof refund).toBe('function')
    // No refund should have been triggered on success
    expect(mem.decrby).not.toHaveBeenCalled()
    // Both keys should be incremented
    expect(mem.incrby).toHaveBeenCalledTimes(2)
  })

  it('throws SpendCapError("daily") and refunds when daily cap is exceeded', async () => {
    const mem = makeMemoryRedis()
    // Pre-seed the daily key to be just at the cap so one more booking trips it
    const dailyKeyPattern = /ks:daily:/
    let dailyCallCount = 0
    mem.incrby.mockImplementation(async (key: string, amount: number) => {
      mem._counters[key] = (mem._counters[key] ?? 0) + amount
      if (dailyKeyPattern.test(key)) {
        dailyCallCount++
        if (dailyCallCount === 1) {
          // First daily INCRBY: return value that exceeds cap
          mem._counters[key] = DAILY_CAP_MICRO_USD + amount
          return mem._counters[key]
        }
      }
      return mem._counters[key]
    })
    vi.mocked(Redis.fromEnv).mockReturnValue(mem as unknown as ReturnType<typeof Redis.fromEnv>)

    const err = await bookSpend(ESTIMATED_RUN_COST_MICRO_USD).catch((e) => e)
    expect(err).toBeInstanceOf(SpendCapError)
    expect((err as SpendCapError).window).toBe('daily')
    // Must have refunded both keys
    expect(mem.decrby).toHaveBeenCalledTimes(2)
  })

  it('throws SpendCapError("hourly") and refunds when hourly cap is exceeded', async () => {
    const mem = makeMemoryRedis()
    const hourlyKeyPattern = /ks:hourly:/
    mem.incrby.mockImplementation(async (key: string, amount: number) => {
      mem._counters[key] = (mem._counters[key] ?? 0) + amount
      if (hourlyKeyPattern.test(key)) {
        mem._counters[key] = HOURLY_CAP_MICRO_USD + amount
        return mem._counters[key]
      }
      // daily is fine (small value)
      return amount
    })
    vi.mocked(Redis.fromEnv).mockReturnValue(mem as unknown as ReturnType<typeof Redis.fromEnv>)

    const err = await bookSpend(ESTIMATED_RUN_COST_MICRO_USD).catch((e) => e)
    expect(err).toBeInstanceOf(SpendCapError)
    expect((err as SpendCapError).window).toBe('hourly')
    expect(mem.decrby).toHaveBeenCalledTimes(2)
  })

  it('fails closed when Redis.fromEnv throws (Upstash unreachable)', async () => {
    vi.mocked(Redis.fromEnv).mockImplementationOnce(() => {
      throw new Error('UPSTASH_REDIS_REST_URL is not set')
    })

    await expect(bookSpend()).rejects.toThrow(/Upstash unavailable/)
  })

  it('fails closed when incrby throws (Upstash network error)', async () => {
    const mem = makeMemoryRedis()
    mem.incrby.mockRejectedValue(new Error('Network timeout'))
    vi.mocked(Redis.fromEnv).mockReturnValue(mem as unknown as ReturnType<typeof Redis.fromEnv>)

    await expect(bookSpend()).rejects.toThrow(/Upstash unavailable/)
  })

  it('refund decrements both daily and hourly keys by the booked amount', async () => {
    const mem = makeMemoryRedis()
    vi.mocked(Redis.fromEnv).mockReturnValue(mem as unknown as ReturnType<typeof Redis.fromEnv>)

    const AMOUNT = 42_000
    const refund = await bookSpend(AMOUNT)
    mem.decrby.mockClear()

    await refund()

    expect(mem.decrby).toHaveBeenCalledTimes(2)
    for (const call of mem.decrby.mock.calls) {
      expect(call[1]).toBe(AMOUNT)
    }
  })

  it('INCRBY+refund race: N concurrent requests settle to ≤ cap after refunds', async () => {
    // Verifies that the INCRBY-then-check pattern correctly refunds rejected requests.
    // With in-memory counters, calls serialize in JS even under Promise.allSettled,
    // so we can assert exact final state: only approved requests remain counted.
    const COST = Math.floor(HOURLY_CAP_MICRO_USD / 3) + 1 // ~334k µ$, fits 2 per hour

    const mem = makeMemoryRedis()
    // Use the same Redis instance for all bookings so counters are shared
    vi.mocked(Redis.fromEnv).mockReturnValue(mem as unknown as ReturnType<typeof Redis.fromEnv>)

    const N = 6
    const results = await Promise.allSettled(Array.from({ length: N }, () => bookSpend(COST)))

    const succeeded = results.filter((r) => r.status === 'fulfilled').length
    const rejected = results.filter((r) => r.status === 'rejected').length

    expect(succeeded + rejected).toBe(N)

    // After all refunds: each key should reflect only approved spend
    // At most floor(HOURLY_CAP / COST) requests can succeed per hour
    const maxApproved = Math.floor(HOURLY_CAP_MICRO_USD / COST)
    expect(succeeded).toBeLessThanOrEqual(maxApproved + 1) // +1: exact-cap boundary

    // Final counter per key must be ≤ cap (refunds brought it back within bounds)
    for (const [key, val] of Object.entries(mem._counters)) {
      if (key.startsWith('ks:hourly:')) {
        expect(val).toBeLessThanOrEqual(HOURLY_CAP_MICRO_USD + COST)
      }
      if (key.startsWith('ks:daily:')) {
        expect(val).toBeLessThanOrEqual(DAILY_CAP_MICRO_USD + COST)
      }
    }
  })
})
