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
import { _resetInstanceForTest, getClientIp, rateLimitKey, checkRateLimit } from '../ratelimit'
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
  // The trusted helper (@vercel/functions ipAddress) reads the proxy-set
  // `x-real-ip` header, NEVER a raw client-spoofable `x-forwarded-for`.
  it('reads the platform-trusted x-real-ip header', () => {
    const req = makeRequest({ 'x-real-ip': '9.9.9.9' })
    expect(getClientIp(req as unknown as import('next/server').NextRequest)).toBe('9.9.9.9')
  })

  it('does NOT trust a raw x-forwarded-for header (spoofable) — falls back to loopback', () => {
    const req = makeRequest({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })
    expect(getClientIp(req as unknown as import('next/server').NextRequest)).toBe('127.0.0.1')
  })

  it('returns 127.0.0.1 when no trusted IP header is present', () => {
    const req = makeRequest()
    expect(getClientIp(req as unknown as import('next/server').NextRequest)).toBe('127.0.0.1')
  })
})

describe('rateLimitKey() — IPv6 /64 keying (arch S23)', () => {
  it('keys an IPv4 address on the full address (a /32, unchanged)', () => {
    expect(rateLimitKey('203.0.113.42')).toBe('203.0.113.42')
  })

  it('keys an IPv6 address on its /64 prefix', () => {
    expect(rateLimitKey('2001:db8:abcd:1234:5678:9abc:def0:1')).toBe('2001:db8:abcd:1234::/64')
  })

  it('two distinct /128s within the SAME /64 share one bucket', () => {
    const a = rateLimitKey('2001:db8:abcd:1234:0:0:0:1')
    const b = rateLimitKey('2001:db8:abcd:1234:ffff:ffff:ffff:ffff')
    expect(a).toBe(b)
    expect(a).toBe('2001:db8:abcd:1234::/64')
  })

  it('two /128s in DIFFERENT /64s get distinct buckets', () => {
    const a = rateLimitKey('2001:db8:abcd:1234::1')
    const b = rateLimitKey('2001:db8:abcd:9999::1')
    expect(a).not.toBe(b)
  })

  it('expands `::` zero-run compression before taking the /64', () => {
    // 2001:db8::1 → 2001:db8:0:0:0:0:0:1 → /64 prefix is 2001:db8:0:0
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    // Leading-zero hextets are normalised (0db8 → db8) so compressed and
    // padded forms of the same address collapse to the same bucket.
    expect(rateLimitKey('2001:0db8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8:0:0::/64')
  })

  it('normalises an embedded-IPv4 tail without affecting the /64 prefix', () => {
    // The embedded v4 sits in the low 32 bits, so the /64 prefix is unchanged.
    const a = rateLimitKey('2001:db8:abcd:1234::ffff:1.2.3.4')
    const b = rateLimitKey('2001:db8:abcd:1234::ffff:5.6.7.8')
    expect(a).toBe(b)
    expect(a).toBe('2001:db8:abcd:1234::/64')
  })

  it('falls back to the literal for an unparseable IPv6 (still bounded, never fail-open)', () => {
    expect(rateLimitKey('not:a:valid::ip::xyz')).toBe('not:a:valid::ip::xyz')
  })
})

describe('checkRateLimit()', () => {
  it('returns ok:true when limit allows the request', async () => {
    const { _mockLimit } = await import('@upstash/ratelimit') as unknown as { _mockLimit: ReturnType<typeof vi.fn> }
    _mockLimit.mockResolvedValueOnce({
      success: true,
      limit: 10,
      remaining: 9,
      reset: Date.now() + 3600_000,
    })

    const req = makeRequest({ 'x-real-ip': '1.2.3.4' })
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

    const req = makeRequest({ 'x-real-ip': '1.2.3.4' })
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
    const req = makeRequest({ 'x-real-ip': ip })

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

  it('IPv6 clients are keyed on the /64 prefix, not the full /128', async () => {
    const { _mockLimit } = await import('@upstash/ratelimit') as unknown as { _mockLimit: ReturnType<typeof vi.fn> }
    _mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 8, reset: 0 })

    // Two different /128 addresses inside one /64 must hit the SAME bucket key.
    await checkRateLimit(makeRequest({ 'x-real-ip': '2001:db8:abcd:1234::1' }) as unknown as import('next/server').NextRequest)
    await checkRateLimit(makeRequest({ 'x-real-ip': '2001:db8:abcd:1234::2' }) as unknown as import('next/server').NextRequest)

    const calls = _mockLimit.mock.calls
    expect(calls[0][0]).toBe('2001:db8:abcd:1234::/64')
    expect(calls[1][0]).toBe('2001:db8:abcd:1234::/64')
  })

  it('uses a singleton Ratelimit instance across calls (shared bucket property)', async () => {
    const { _mockLimit } = await import('@upstash/ratelimit') as unknown as { _mockLimit: ReturnType<typeof vi.fn> }
    _mockLimit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 })

    const req = makeRequest({ 'x-real-ip': '10.0.0.1' })
    await checkRateLimit(req as unknown as import('next/server').NextRequest)
    await checkRateLimit(req as unknown as import('next/server').NextRequest)

    // The Ratelimit constructor should be called at most once (singleton)
    expect(vi.mocked(Ratelimit)).toHaveBeenCalledTimes(1)
  })
})
