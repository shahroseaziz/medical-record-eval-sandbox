import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { Client } from 'pg'
import { applySchema } from '../lib/db/index'
import { GET } from '../app/api/patients/route'

// Drives the real route handler against a live pgvector (DATABASE_URL). No Voyage
// needed — the /api/patients route reads only the patients table, so we seed
// patient rows with summary-v3 jsonb directly.
const hasDb = !!process.env.DATABASE_URL

function makeSummary(over: Partial<Record<string, unknown>> = {}) {
  return {
    demographics: { firstName: 'X', lastName: 'Y', gender: 'F', birthDate: '19800101' },
    sections: ['problems', 'medications'],
    age: 45,
    sex: 'F',
    conditionCount: 3,
    medCount: 2,
    chartBytes: 12345,
    ...over,
  }
}

function req(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/patients${query}`)
}

describe.skipIf(!hasDb)('GET /api/patients (live pgvector)', () => {
  let client: Client

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL })
    await client.connect()
    await applySchema(client)
    await client.query('TRUNCATE traces, seed_meta, chunks, patients CASCADE')

    // Inserted out of name order to prove ?all=1 sorts deterministically by name.
    await client.query(`INSERT INTO patients (id, name, summary) VALUES ($1, $2, $3)`, [
      'pt-bob',
      'Bob Brown',
      JSON.stringify(makeSummary({ sex: 'M', age: 60, conditionCount: 7, medCount: 4, chartBytes: 999 })),
    ])
    await client.query(`INSERT INTO patients (id, name, summary) VALUES ($1, $2, $3)`, [
      'pt-alice',
      'Alice Anderson',
      JSON.stringify(makeSummary()),
    ])
  })

  afterAll(async () => {
    await client.end()
  })

  it('?all=1 returns every patient in deterministic name order with summary-v3 fields', async () => {
    const res = await GET(req('?all=1'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      patients: Array<{
        id: string
        name: string
        summary: { demographics: unknown; sections: string[] }
        age: number | null
        sex: string
        conditionCount: number
        medCount: number
        chartBytes: number
      }>
      count: number
    }

    expect(body.count).toBe(2)
    // Deterministic order by name: Alice before Bob.
    expect(body.patients.map((p) => p.name)).toEqual(['Alice Anderson', 'Bob Brown'])

    const alice = body.patients[0]
    // summary-v3 fields surfaced at top level
    expect(alice.age).toBe(45)
    expect(alice.sex).toBe('F')
    expect(alice.conditionCount).toBe(3)
    expect(alice.medCount).toBe(2)
    expect(alice.chartBytes).toBe(12345)
    // additive: pre-v3 summary shape preserved
    expect(alice.summary.demographics).toBeDefined()
    expect(alice.summary.sections).toEqual(['problems', 'medications'])

    const bob = body.patients[1]
    expect(bob.sex).toBe('M')
    expect(bob.conditionCount).toBe(7)
  })

  it('no-arg call is unchanged: returns a sample of {id,name,summary}', async () => {
    const res = await GET(req(''))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      patients: Array<{ id: string; name: string; summary: unknown }>
      count?: number
    }
    expect(Array.isArray(body.patients)).toBe(true)
    expect(body.patients.length).toBeGreaterThan(0)
    expect(body.patients.length).toBeLessThanOrEqual(5) // default n
    // The legacy shape carries summary whole, with no `count` envelope field.
    expect(body.count).toBeUndefined()
    for (const p of body.patients) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.name).toBe('string')
      expect(p.summary).toBeDefined()
    }
  })
})
