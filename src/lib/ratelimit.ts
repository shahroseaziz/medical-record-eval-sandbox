import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { ipAddress } from '@vercel/functions'
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

// Extract the client IP using the platform's TRUSTED helper. On Vercel,
// `ipAddress()` reads the proxy-set `x-real-ip` header — the only forwarding
// header the platform guarantees, derived from the real edge connection. We
// deliberately do NOT parse a raw `X-Forwarded-For`: that header is
// client-spoofable, so keying the limiter on its leftmost value would let an
// attacker forge an arbitrary identity and bypass the per-IP allowance
// (arch S23 / cycle-3 matrix #334). Falls back to a loopback literal only when
// no trusted IP is present (local dev / tests).
export function getClientIp(req: NextRequest): string {
  return ipAddress(req) ?? '127.0.0.1'
}

// Expand an IPv6 address to its 8 hextet groups (lowercase, leading zeros
// stripped per group). Handles `::` zero-run compression, a single embedded
// IPv4 tail (e.g. `::ffff:1.2.3.4`), and a `%zone` suffix. Returns null for any
// input that does not parse as a valid IPv6 literal.
function expandIpv6Groups(input: string): string[] | null {
  let addr = input.split('%')[0] // strip a zone index (fe80::1%eth0)

  // Convert a trailing embedded IPv4 (`…:1.2.3.4`) into its two hextets so the
  // result is always 8 hex groups. The embedded v4 only ever sits in the low 32
  // bits, so it never affects the /64 prefix — but we normalise it for a valid parse.
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':')
    if (lastColon === -1) return null
    const octets = addr.slice(lastColon + 1).split('.')
    if (octets.length !== 4) return null
    const nums = octets.map((o) => Number(o))
    if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
    const g1 = ((nums[0] << 8) | nums[1]).toString(16)
    const g2 = ((nums[2] << 8) | nums[3]).toString(16)
    addr = `${addr.slice(0, lastColon)}:${g1}:${g2}`
  }

  // At most one `::` zero-run is legal.
  const dbl = addr.indexOf('::')
  if (dbl !== -1 && dbl !== addr.lastIndexOf('::')) return null

  let groups: string[]
  if (dbl !== -1) {
    const [head, tail] = addr.split('::')
    const headGroups = head ? head.split(':') : []
    const tailGroups = tail ? tail.split(':') : []
    const missing = 8 - headGroups.length - tailGroups.length
    if (missing < 0) return null // `::` must stand in for at least one group
    groups = [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
  } else {
    groups = addr.split(':')
  }

  if (groups.length !== 8) return null

  const normalised: string[] = []
  for (const g of groups) {
    const v = g === '' ? '0' : g
    if (!/^[0-9a-fA-F]{1,4}$/.test(v)) return null
    normalised.push(parseInt(v, 16).toString(16))
  }
  return normalised
}

// Derive the rate-limit bucket key from a client IP.
//   • IPv4 → the full address (a /32; one bucket per host, unchanged from S9).
//   • IPv6 → the /64 PREFIX (first four hextets). A single IPv6 customer is
//     routinely delegated a whole /64 (2^64 addresses), so per-/128 keying would
//     make rotation free — burn the bucket, hop to the next address, repeat
//     (arch S23: "per-/128 keying makes rotation free"). Keying on the /64 puts
//     every address a single client controls into ONE bucket.
// An IP that fails to parse as IPv6 falls back to keying on the literal itself —
// still bounded (one bucket), never fail-open.
export function rateLimitKey(ip: string): string {
  if (!ip.includes(':')) return ip // IPv4 or a non-IP fallback literal
  const groups = expandIpv6Groups(ip)
  if (!groups) return ip
  return `${groups.slice(0, 4).join(':')}::/64`
}

export interface RateLimitResult {
  ok: boolean
  headers: Record<string, string>
}

// Checks the shared sliding-window bucket for the request's IP. IPv6 clients are
// keyed on their /64 prefix (see rateLimitKey). Returns rate-limit headers
// regardless of outcome so callers can forward them.
export async function checkRateLimit(req: NextRequest): Promise<RateLimitResult> {
  const key = rateLimitKey(getClientIp(req))
  const result = await getInstance().limit(key)
  return {
    ok: result.success,
    headers: {
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(result.reset),
    },
  }
}
