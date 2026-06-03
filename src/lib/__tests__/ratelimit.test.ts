import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@upstash/ratelimit', () => {
  const mockLimit = vi.fn()
  const MockRatelimit = Object.assign(
    vi.fn().mockImplementation(() => ({ limit: mockLimit })),
    { slidingWindow: vi.fn().mockReturnValue('sliding-window-config') },
  )
  return { Ratelimit: MockRatelimit, _mockLimit: mockLimit }
})

vi.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: vi.fn().mockReturnValue({}),
  },
}))

// Reset the singleton between tests so each test gets a fresh Ratelimit instance
import { _resetInstanceForTest, getClientIp, checkRateLimit } from '../ratelimit'
import { Ratelimit } from '@upstash/ratelimit'

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/run', {
    method: 'POST',
    headers,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetInstanceForTest()
})

describe('getClientIp()', () => {
  it('extracts the leftmost IP from x-forwarded-for', () => {
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    expect(getClientIp(req as unknown as import('next/server').NextRequest)).toBe('1.2.3.4')
  })

  it('falls back to x-real-ip when x-forwarded-for is absent', () => {
    const req = makeRequest({ 'x-real-ip': '9.9.9.9' })
    expect(getClientIp(req as unknown as import('next/server').NextRequest)).toBe('9.9.9.9')
  })

  it('returns 127.0.0.1 when no IP headers are present', () => {
    const req = makeRequest()
    expect(getClientIp(req as unknown as import('next/server').NextRequest)).toBe('127.0.0.1')
  })
})

describe('checkRateLimit()', () => {
  it('returns ok:true when limit allows the request', async () => {
    const mockLimit = vi.mocked(Ratelimit).mock.results[0]?.value?.limit
    // We need to get the mock limit fn from the module
    const { _mockLimit } = await import('@upstash/ratelimit') as unknown as { _mockLimit: ReturnType<typeof vi.fn> }
    _mockLimit.mockResolvedValueOnce({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 3600_000,
    })
    void mockLimit

    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4' })
    const result = await checkRateLimit(req as unknown as import('next/server').NextRequest)

    expect(result.ok).toBe(true)
    expect(result.headers['X-RateLimit-Remaining']).toBe('9')
  })

  it('returns ok:false when rate limit is exceeded', async () => {
    const { _mockLimit } = await import('@upstash/ratelimit') as unknown as { _mockLimit: ReturnType<typeof vi.fn> }
    _mockLimit.mockResolvedValueOnce({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 3600_000,
    })

    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4' })
    const result = await checkRateLimit(req as unknown as import('next/server').NextRequest)

    expect(result.ok).toBe(false)
    expect(result.headers['X-RateLimit-Remaining']).toBe('0')
  })

  it('shared bucket: same identifier used for requests from the same IP', async () => {
    const { _mockLimit } = await import('@upstash/ratelimit') as unknown as { _mockLimit: ReturnType<typeof vi.fn> }
    _mockLimit.mockResolvedValue({
      success: true,
      limit: 10,
      remaining: 8,
      reset: Date.now() + 3600_000,
    })

    const ip = '203.0.113.42'
    const req = makeRequest({ 'x-forwarded-for': ip })

    // Simulate calls from two different routes (same IP)
    await checkRateLimit(req as unknown as import('next/server').NextRequest)
    await checkRateLimit(req as unknown as import('next/server').NextRequest)

    // Both calls must use the same identifier (IP) — the ratelimiter deducts from
    // one shared bucket, not two separate ones per route.
    const calls = _mockLimit.mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toBe(ip)
    expect(calls[1][0]).toBe(ip)
  })

  it('uses a singleton Ratelimit instance across calls (shared bucket property)', async () => {
    const { _mockLimit } = await import('@upstash/ratelimit') as unknown as { _mockLimit: ReturnType<typeof vi.fn> }
    _mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 })

    const req = makeRequest({ 'x-forwarded-for': '10.0.0.1' })
    await checkRateLimit(req as unknown as import('next/server').NextRequest)
    await checkRateLimit(req as unknown as import('next/server').NextRequest)

    // The Ratelimit constructor should be called at most once (singleton)
    expect(vi.mocked(Ratelimit)).toHaveBeenCalledTimes(1)
  })
})
