export const runtime = 'nodejs'

import { type NextRequest } from 'next/server'
import { withClient } from '@/lib/db/index'

interface PatientRow {
  id: string
  name: string
  summary: unknown
}

// summary-v3 fields the data-explorer drawer reads, surfaced at the top level for
// convenience while `summary` (which also carries demographics+sections) is kept whole.
interface AllPatientRow extends PatientRow {
  age: number | null
  sex: string
  conditionCount: number
  medCount: number
  chartBytes: number
}

function flattenV3(row: PatientRow): AllPatientRow {
  const s = (row.summary ?? {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return {
    ...row,
    age: typeof s.age === 'number' ? s.age : null,
    sex: typeof s.sex === 'string' ? s.sex : '',
    conditionCount: num(s.conditionCount),
    medCount: num(s.medCount),
    chartBytes: num(s.chartBytes),
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  // ?all=1 → every patient in deterministic (name) order, each carrying the
  // summary-v3 explorer fields. The no-arg / ?n= path keeps the original random
  // sample untouched for existing callers.
  const all = req.nextUrl.searchParams.get('all') === '1'

  try {
    if (all) {
      const patients = await withClient(async (client) => {
        const result = await client.query(
          'SELECT id, name, summary FROM patients ORDER BY name, id',
        )
        return (result.rows as PatientRow[]).map(flattenV3)
      })
      return Response.json({ patients, count: patients.length })
    }

    const n = Math.min(Math.max(1, parseInt(req.nextUrl.searchParams.get('n') ?? '5', 10)), 20)
    const patients = await withClient(async (client) => {
      const result = await client.query(
        'SELECT id, name, summary FROM patients ORDER BY random() LIMIT $1',
        [n],
      )
      return result.rows as PatientRow[]
    })
    return Response.json({ patients })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Database error'
    return Response.json({ error: msg }, { status: 503 })
  }
}
