export const runtime = 'nodejs'
export const maxDuration = 30

import { NextRequest, NextResponse } from 'next/server'
import { retrieve } from '@/lib/rag/index'

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!process.env.VOYAGE_API_KEY) {
    return NextResponse.json(
      { error: 'Retrieval needs a Voyage key: VOYAGE_API_KEY is not configured' },
      { status: 503 }
    )
  }

  let body: { patientId?: string; query?: string; k?: number }
  try {
    body = (await req.json()) as { patientId?: string; query?: string; k?: number }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.patientId || !body.query) {
    return NextResponse.json(
      { error: 'patientId and query are required' },
      { status: 400 }
    )
  }

  try {
    const result = await retrieve(body.patientId, body.query, body.k)
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
