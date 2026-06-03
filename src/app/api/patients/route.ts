export const runtime = 'nodejs'

import { type NextRequest } from 'next/server'
import { withClient } from '@/lib/db/index'

export async function GET(req: NextRequest): Promise<Response> {
  const n = Math.min(Math.max(1, parseInt(req.nextUrl.searchParams.get('n') ?? '5', 10)), 20)

  try {
    const patients = await withClient(async (client) => {
      const result = await client.query(
        'SELECT id, name, summary FROM patients ORDER BY random() LIMIT $1',
        [n],
      )
      return result.rows as Array<{ id: string; name: string; summary: unknown }>
    })
    return Response.json({ patients })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Database error'
    return Response.json({ error: msg }, { status: 503 })
  }
}
