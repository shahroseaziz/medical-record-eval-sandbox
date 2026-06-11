export const runtime = 'nodejs'

import { type NextRequest } from 'next/server'
import { withClient } from '@/lib/db/index'
import {
  assembleStuffRecord,
  recordFitsBudget,
  recordTokenEstimate,
  RECORD_BUDGET_TOKENS,
  type RecordChunk,
} from '@/lib/workbench/composer'

// "Give me N random patients" with the D3 record-size guard. The sample is drawn
// UNIFORMLY over the budget-ELIGIBLE patient set: we pull a random candidate pool,
// assemble each candidate's stuff-mode record, drop the ones that would overflow
// the 12k assembly budget (via O1's local token counter — no count_tokens
// round-trip, S25), and return the first N survivors in random order. Because the
// pool is itself a uniform random sample of all patients, its eligible subset is a
// uniform random sample of all eligible patients (D3).
//
// This is the guard that makes "5 random → 5 authorable skeletons, none
// dead-on-arrival" hold: an over-budget patient is never handed to the composer.

const MAX_N = 20
// Over-sample so the guard has room to reject overflow patients and still return N.
// Capped so a pathological corpus can't assemble an unbounded number of full
// records server-side just to discard them.
const POOL_MULTIPLE = 4
const MAX_POOL = 80

export interface SampledPatient {
  id: string
  name: string
  summary: unknown
  /** The assembled stuff-mode record (what the record view renders + the run grounds on). */
  record: string
  /** The local, margined token estimate of `record` (fail-closed, O1). */
  recordTokens: number
}

export async function GET(req: NextRequest): Promise<Response> {
  const n = Math.min(Math.max(1, parseInt(req.nextUrl.searchParams.get('n') ?? '5', 10)), MAX_N)
  const poolSize = Math.min(Math.max(n * POOL_MULTIPLE, n + 10), MAX_POOL)

  try {
    const rows = await withClient(async (client) => {
      // A uniform random pool of patients joined to their chunks. `rn` carries the
      // random order through the join so the eligible survivors keep a uniform order.
      const result = await client.query(
        `WITH pool AS (
           SELECT id, name, summary, row_number() OVER (ORDER BY random()) AS rn
           FROM patients
           ORDER BY random()
           LIMIT $1
         )
         SELECT pool.id, pool.name, pool.summary, pool.rn,
                c.section, c.ord, c.text
         FROM pool
         JOIN chunks c ON c.patient_id = pool.id
         ORDER BY pool.rn, c.section, c.ord`,
        [poolSize],
      )
      return result.rows as Array<{
        id: string
        name: string
        summary: unknown
        rn: number
        section: string
        ord: number
        text: string
      }>
    })

    // Group chunks per patient, preserving the random (rn) order of first appearance.
    const order: string[] = []
    const byId = new Map<
      string,
      { id: string; name: string; summary: unknown; chunks: RecordChunk[] }
    >()
    for (const r of rows) {
      let entry = byId.get(r.id)
      if (!entry) {
        entry = { id: r.id, name: r.name, summary: r.summary, chunks: [] }
        byId.set(r.id, entry)
        order.push(r.id)
      }
      entry.chunks.push({ section: r.section, ord: r.ord, text: r.text })
    }

    const eligible: SampledPatient[] = []
    for (const id of order) {
      if (eligible.length >= n) break
      const entry = byId.get(id)!
      const record = assembleStuffRecord(entry.chunks)
      if (!recordFitsBudget(record)) continue // D3 guard: drop over-budget patients
      eligible.push({
        id: entry.id,
        name: entry.name,
        summary: entry.summary,
        record,
        recordTokens: recordTokenEstimate(record),
      })
    }

    return Response.json({
      patients: eligible,
      requested: n,
      returned: eligible.length,
      poolSize,
      budgetTokens: RECORD_BUDGET_TOKENS,
      // True when the guard could not fill the request from the sampled pool — the
      // composer surfaces this honestly rather than silently returning fewer.
      shortfall: eligible.length < n,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Database error'
    return Response.json({ error: msg }, { status: 503 })
  }
}
