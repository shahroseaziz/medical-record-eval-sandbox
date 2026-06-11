import { describe, it, expect } from 'vitest'
import { buildBenchGenerationRequest, EXPECTED_FIELD_KEYS } from '../firewall'
import { buildPrompt, buildGroundingContext } from '@/lib/run/prompt'
import type { BenchCaseV4 } from '@/lib/cases'
import type { RetrievedChunk } from '@/lib/rag/index'

// ── E25 firewall extension ───────────────────────────────────────────────────
//
// Hand-authored answer-key fields (expectedProse / expectedStructured / the scorer
// assignment) must NEVER reach a generation prompt or a persisted trace. We plant
// unique sentinels in those fields, drive a case through the generation chokepoint
// (`buildBenchGenerationRequest`) and the SAME prompt assembly the route uses, then
// grep the request, the assembled prompt, and a persisted-trace projection for any
// leak (S19 marker pattern).

const PROSE_SENTINEL = 'FIREWALL_PROSE_LEAK_SENTINEL_4f2a'
const STRUCT_SENTINEL = 'FIREWALL_STRUCT_LEAK_SENTINEL_9c7b'
const SENTINELS = [PROSE_SENTINEL, STRUCT_SENTINEL]

function makeCase(ragMode: 'retrieve' | 'stuff'): BenchCaseV4 {
  return {
    version: 4,
    id: 'fw-case',
    taskPrompt: 'List this patient’s active medications.',
    patientId: 'patient-007',
    ragMode,
    expectedProse: `${PROSE_SENTINEL}: the patient takes Lisinopril 10mg daily.`,
    expectedStructured: [
      { drug: `${STRUCT_SENTINEL}`, dose: '10mg', route: 'PO', status: 'active' },
    ],
    fieldScorers: { prose: 'reference-judge', structured: 'structured-diff' },
    createdAt: 0,
  }
}

// Benign grounding — the actual record/chunks the generator legitimately sees. It
// must NOT contain any answer-key sentinel.
const RECORD = 'Medications: Lisinopril 10mg PO daily. Atorvastatin 20mg PO nightly.'
const CHUNKS: RetrievedChunk[] = [
  { section: 'medications', text: RECORD, distance: 0.1, similarity: 0.9 },
]

function scanForLeak(haystack: string): string[] {
  return SENTINELS.filter((s) => haystack.includes(s))
}

describe('generation firewall — expected fields never reach generation (E25)', () => {
  it('the chokepoint is the only declared firewall surface', () => {
    expect(EXPECTED_FIELD_KEYS).toContain('expectedProse')
    expect(EXPECTED_FIELD_KEYS).toContain('expectedStructured')
    expect(EXPECTED_FIELD_KEYS).toContain('fieldScorers')
  })

  it('stuff mode: no answer-key sentinel in the request, assembled prompt, or trace', () => {
    const c = makeCase('stuff')
    const req = buildBenchGenerationRequest(c, { record: RECORD })

    // 1. The request object carries no expected-field keys at all.
    for (const key of EXPECTED_FIELD_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(req, key)).toBe(false)
    }
    expect(scanForLeak(JSON.stringify(req))).toEqual([])

    // 2. The assembled generation prompt (same assembly the route uses).
    const grounding = buildGroundingContext('stuff', [], req.record)
    const { systemPrompt, userTurnPrompt } = buildPrompt(req.query, grounding, req.generationPrompt)
    const assembled = `${systemPrompt}\n\n${userTurnPrompt}`
    expect(scanForLeak(assembled)).toEqual([])
    expect(assembled).toContain('Lisinopril') // the real record IS present

    // 3. A persisted-trace projection (grounding + assembled prompt + output).
    const traceLike = JSON.stringify({ grounding, assembled, output: 'Lisinopril 10mg daily.' })
    expect(scanForLeak(traceLike)).toEqual([])
  })

  it('retrieve mode: no answer-key sentinel in the request, assembled prompt, or trace', () => {
    const c = makeCase('retrieve')
    const req = buildBenchGenerationRequest(c, { k: 6, generationPrompt: 'Be concise.' })

    for (const key of EXPECTED_FIELD_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(req, key)).toBe(false)
    }
    expect(scanForLeak(JSON.stringify(req))).toEqual([])

    const grounding = buildGroundingContext('retrieve', CHUNKS)
    const { systemPrompt, userTurnPrompt } = buildPrompt(req.query, grounding, req.generationPrompt)
    const assembled = `${systemPrompt}\n\n${userTurnPrompt}`
    expect(scanForLeak(assembled)).toEqual([])
    expect(assembled).toContain('medications')

    const traceLike = JSON.stringify({
      grounding,
      assembled,
      chunks: CHUNKS,
      output: 'Lisinopril 10mg daily.',
    })
    expect(scanForLeak(traceLike)).toEqual([])
  })

  it('a wider case object cannot leak an expected field through the chokepoint', () => {
    // Even when the full case (with sentinels) is passed, only allow-listed
    // generation fields are copied — the request never gains an expected field.
    const c = makeCase('stuff')
    const req = buildBenchGenerationRequest(c, { record: RECORD })
    expect(Object.keys(req).sort()).toEqual(['mode', 'patientId', 'query', 'record'])
  })
})
