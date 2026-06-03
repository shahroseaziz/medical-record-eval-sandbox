import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import type { NextRequest } from 'next/server'

// Singleton shared across all routes so that /api/run, /api/retrieve, and
// /api/score all decrement from a single per-IP allowance of 10 req/hr.
let _instance: Ratelimit | null = null

function getInstance(): Ratelimit {
  if (!_instance) {
    _instance = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(10, '1 h'),
      prefix: 'rl:run',
    })
  }
  return _instance
}

// For tests only — resets the singleton so vi.mock picks up a fresh instance.
export function _resetInstanceForTest(): void {
  _instance = null
}

// Extract the client IP from Vercel's trusted x-forwarded-for header.
// Takes the leftmost address (the original client), strips proxy hops.
export function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? '127.0.0.1'
}

export interface RateLimitResult {
  ok: boolean
  headers: Record<string, string>
}

// Checks the shared sliding-window bucket for the request's IP.
// Returns rate-limit headers regardless of outcome so callers can forward them.
export async function checkRateLimit(req: NextRequest): Promise<RateLimitResult> {
  const ip = getClientIp(req)
  const result = await getInstance().limit(ip)
  return {
    ok: result.success,
    headers: {
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(result.reset),
    },
  }
}
