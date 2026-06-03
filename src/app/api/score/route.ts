export const runtime = 'nodejs'
export const maxDuration = 60

import { NextRequest } from 'next/server'
import { checkRateLimit } from '@/lib/ratelimit'
import { bookSpend, SpendCapError } from '@/lib/killswitch'

// /api/score: standalone scoring endpoint (implementation in a future step).
// Guardrails are wired here so the shared rate-limit bucket and spend caps
// apply consistently when this route is fully implemented.

export async function POST(req: NextRequest): Promise<Response> {
  // Rate limit — shared bucket with /api/run and /api/retrieve (10 req/hr per IP)
  let rlResult: { ok: boolean; headers: Record<string, string> }
  try {
    rlResult = await checkRateLimit(req)
  } catch {
    return Response.json({ error: 'Service temporarily unavailable.' }, { status: 503 })
  }
  if (!rlResult.ok) {
    return Response.json(
      { error: 'Rate limit exceeded. Max 10 requests per hour per IP.' },
      { status: 429, headers: rlResult.headers },
    )
  }

  let body: Record<string, unknown> = {}
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // BYO key comes from a request header, never from the request body.
  const isByo = Boolean(req.headers.get('x-byo-api-key'))

  // Book free-tier judge spend (BYO bypasses Anthropic caps)
  if (!isByo) {
    try {
      await bookSpend()
    } catch (err) {
      if (err instanceof SpendCapError) {
        return Response.json(
          {
            error:
              'Free-tier usage limit reached. Provide your own Anthropic API key to continue.',
          },
          { status: 429 },
        )
      }
      return Response.json({ error: 'Service temporarily unavailable.' }, { status: 503 })
    }
  }

  return Response.json({ error: 'Not implemented' }, { status: 501 })
}
