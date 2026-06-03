export const runtime = 'nodejs'

import { withClient } from '@/lib/db/index'

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params

  try {
    const chunks = await withClient(async (client) => {
      const result = await client.query(
        'SELECT section, ord, text FROM chunks WHERE patient_id = $1 ORDER BY section, ord',
        [id],
      )
      return result.rows as Array<{ section: string; ord: number; text: string }>
    })
    return Response.json({ chunks })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Database error'
    return Response.json({ error: msg }, { status: 503 })
  }
}
