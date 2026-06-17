export const runtime = 'nodejs'

import { withClient } from '@/lib/db/index'

export async function GET(
  _req: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params

  try {
    const chunks = await withClient(async (client) => {
      // N7b: also return the section-level source_xml (added in N1, nullable) so the
      // explorer's Parsed / Raw-XML toggle can show each section's raw <section> body.
      const result = await client.query(
        'SELECT section, ord, text, source_xml FROM chunks WHERE patient_id = $1 ORDER BY section, ord',
        [id],
      )
      return result.rows as Array<{
        section: string
        ord: number
        text: string
        source_xml: string | null
      }>
    })
    return Response.json({ chunks })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Database error'
    return Response.json({ error: msg }, { status: 503 })
  }
}
