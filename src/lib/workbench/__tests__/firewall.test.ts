import { describe, it, expect } from 'vitest'
import { buildBenchGenerationRequest, EXPECTED_FIELD_KEYS } from '../firewall'
import { buildPrompt, buildGroundingContext } from '@/lib/run/prompt'
import { assembleRunTrace } from '@/app/api/run/trace'
import { scoreSectionHit } from '@/lib/eval/index'
import type { EvalCase } from '@/lib/eval/index'
import type { BenchCaseV4 } from '@/lib/cases'
import type { RetrievedChunk } from '@/lib/rag/index'

// ── E25 firewall extension ───────────────────────────────────────────────────
//
// Hand-authored answer-key fields (expectedProse / expectedStructured / the scorer
// assignment) must NEVER reach a generation prompt or a persisted trace. We plant
// unique sentinels in those fields, drive the case through the SAME path production
// uses — the generation chokepoint (`buildBenchGenerationRequest`, which is what
// `useGenerationRun.generateOneCase` calls), the route's prompt assembly, and the
// route's REAL trace assembler (`assembleRunTrace`) — then grep the request, the
// assembled prompt, and the persisted trace for any leak (S19 marker pattern).
//
// Greping the real `assembleRunTrace` (not a hand-built JSON projection) is what
// makes this a regression guard: a leak introduced in the route's trace assembly
// would now fail here.

const PROSE_SENTINEL = 'FIREWALL_PROSE_LEAK_SENTINEL_4f2a'
const STRUCT_SENTINEL = 'FIREWALL_STRUCT_LEAK_SENTINEL_9c7b'
const SCORER_SENTINEL = 'FIREWALL_SCORER_LEAK_SENTINEL_1d3e'
const SENTINELS = [PROSE_SENTINEL, STRUCT_SENTINEL, SCORER_SENTINEL]

// A full bench case whose answer-key fields carry sentinels. This is the wide
// object the firewall must refuse to copy expected fields out of.
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

// Drive a firewalled request through the route's real trace path: section-hit
// scoring (deterministic, no model call) + `assembleRunTrace`. The model output is
// benign; if any answer-key field leaked into generation it could only appear here
// via the request, the grounding, or the assembled prompt — all checked.
function assembleTraceFrom(
  req: ReturnType<typeof buildBenchGenerationRequest>,
  mode: 'retrieve' | 'stuff',
  grounding: string,
  assembledPrompt: string,
  chunks: RetrievedChunk[],
) {
  const output = 'Lisinopril 10mg daily.'
  const evalCase: EvalCase = {
    id: 'fw-trace',
    patientId: req.patientId,
    query: req.query,
    output,
    mode,
    retrievedChunks:
      mode === 'retrieve' ? chunks.map((c) => ({ section: c.section, text: c.text })) : undefined,
    record: mode === 'stuff' ? req.record : undefined,
    k: mode === 'retrieve' ? req.k : undefined,
  }
  return assembleRunTrace({
    caseId: 'fw-trace',
    mode,
    groundingContext: grounding,
    isUserAuthored: Boolean(req.generationPrompt),
    assembledPromptForTrace: assembledPrompt,
    chunks,
    retrievedCount: chunks.length,
    inBudgetCount: chunks.length,
    sectionHit: scoreSectionHit(evalCase),
    faithfulness: null,
    output,
    generationModel: 'claude-haiku-4-5-20251001',
    judgeModel: 'claude-haiku-4-5-20251001',
    embeddingModel: mode === 'retrieve' ? 'voyage' : 'none',
    tokens: { input: 100, output: 20, estCostUsd: 0.0001 },
    judgeUsesByo: false,
  })
}

describe('generation firewall — expected fields never reach generation (E25)', () => {
  it('the chokepoint is the only declared firewall surface', () => {
    expect(EXPECTED_FIELD_KEYS).toContain('expectedProse')
    expect(EXPECTED_FIELD_KEYS).toContain('expectedStructured')
    expect(EXPECTED_FIELD_KEYS).toContain('fieldScorers')
  })

  it('stuff mode: no answer-key sentinel in the request, assembled prompt, or persisted trace', () => {
    const c = makeCase('stuff')
    const req = buildBenchGenerationRequest(
      { patientId: c.patientId, query: c.taskPrompt, mode: c.ragMode },
      { record: RECORD },
    )

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

    // 3. The REAL persisted trace (route's `assembleRunTrace`, not a hand-built JSON).
    const trace = assembleTraceFrom(req, 'stuff', grounding, assembled, [])
    expect(scanForLeak(JSON.stringify(trace))).toEqual([])
  })

  it('retrieve mode: no answer-key sentinel in the request, assembled prompt, or persisted trace', () => {
    const c = makeCase('retrieve')
    const req = buildBenchGenerationRequest(
      { patientId: c.patientId, query: c.taskPrompt, mode: c.ragMode },
      { k: 6, generationPrompt: 'Be concise.' },
    )

    for (const key of EXPECTED_FIELD_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(req, key)).toBe(false)
    }
    expect(scanForLeak(JSON.stringify(req))).toEqual([])

    const grounding = buildGroundingContext('retrieve', CHUNKS)
    const { systemPrompt, userTurnPrompt } = buildPrompt(req.query, grounding, req.generationPrompt)
    const assembled = `${systemPrompt}\n\n${userTurnPrompt}`
    expect(scanForLeak(assembled)).toEqual([])
    expect(assembled).toContain('medications')

    const trace = assembleTraceFrom(req, 'retrieve', grounding, assembled, CHUNKS)
    expect(scanForLeak(JSON.stringify(trace))).toEqual([])
  })

  it('a wider case object cannot leak an expected field through the chokepoint', () => {
    // Even when a wide object carrying answer-key sentinels is passed, only the
    // allow-listed generation fields are read — the request never gains an expected
    // field. This is the structural guarantee the narrow input type enforces.
    const wide = {
      patientId: 'patient-007',
      query: 'List active meds.',
      mode: 'stuff' as const,
      expectedProse: PROSE_SENTINEL,
      expectedStructured: [{ drug: STRUCT_SENTINEL }],
      fieldScorers: { prose: SCORER_SENTINEL },
    }
    const req = buildBenchGenerationRequest(wide, { record: RECORD })
    expect(Object.keys(req).sort()).toEqual(['mode', 'patientId', 'query', 'record'])
    expect(scanForLeak(JSON.stringify(req))).toEqual([])
  })
})
