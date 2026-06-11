import { describe, it, expect } from 'vitest'
import {
  loadRagBenchCases,
  validateRagCase,
  inBudgetChunks,
  isBudgetTrimmed,
  ragGrounding,
  ragSectionHit,
  INGEST_CHUNK_HISTOGRAM,
  INGEST_HISTOGRAM_TOTAL,
  RAG_TERMS,
  type RagBenchCase,
} from '../rag-cases'

const cases = loadRagBenchCases()
const miss = cases.find((c) => c.caseId === 'rag-agustin-specialist-retrieve-miss')!
const hit = cases.find((c) => c.caseId === 'rag-brenna-allergies-retrieve-hit')!

describe('RAG bench cases — shipped set', () => {
  it('ships at least one hit and one miss demonstrator', () => {
    expect(cases.length).toBeGreaterThanOrEqual(2)
    expect(hit).toBeTruthy()
    expect(miss).toBeTruthy()
  })

  it('every shipped case passes the authoring gate (k ≥ requiredSections.length)', () => {
    expect(() => cases.forEach(validateRagCase)).not.toThrow()
    for (const c of cases) {
      expect(c.k).toBeGreaterThanOrEqual(c.requiredSections.length)
    }
  })
})

describe('grounding difference (G4 accept: same case retrieve vs stuff)', () => {
  it('retrieve and stuff grounding differ for the same case', () => {
    const retrieveG = ragGrounding(miss, 'retrieve')
    const stuffG = ragGrounding(miss, 'stuff')
    expect(retrieveG).not.toEqual(stuffG)
    // stuff sends the whole record; retrieve sends only the inBudget subset → smaller.
    expect(stuffG.length).toBeGreaterThan(retrieveG.length)
  })

  it('retrieve grounding contains ONLY the inBudget chunks, not the full top-k', () => {
    const retrieveG = ragGrounding(miss, 'retrieve')
    // The budget-dropped `specialist` chunk must NOT appear in the sent grounding.
    expect(retrieveG).not.toContain('[specialist]')
    // The inBudget sections do appear.
    for (const ch of inBudgetChunks(miss)) {
      expect(retrieveG).toContain(`[${ch.section}]`)
    }
  })
})

describe('section_hit over the inBudget subset (E12 / S25)', () => {
  it('miss case: required section retrieved in top-k but budget-dropped → section_hit=false', () => {
    // The required `specialist` section IS in the retrieved top-k...
    expect(miss.retrievedChunks.map((c) => c.section)).toContain('specialist')
    // ...but NOT in the inBudget subset actually sent.
    expect(inBudgetChunks(miss).map((c) => c.section)).not.toContain('specialist')
    expect(isBudgetTrimmed(miss)).toBe(true)

    const sh = ragSectionHit(miss, 'retrieve')
    expect(sh.score).toBe(0)
    expect(sh.missingSections).toContain('specialist')
  })

  it('miss case is a BUDGET miss, NOT a config error (k ≥ requiredSections.length)', () => {
    expect(miss.k).toBeGreaterThanOrEqual(miss.requiredSections.length)
    // scoreSectionHit would THROW on a config error; here it returns a clean miss.
    expect(() => ragSectionHit(miss, 'retrieve')).not.toThrow()
  })

  it('hit case: required section is in the inBudget subset → section_hit=true', () => {
    expect(inBudgetChunks(hit).map((c) => c.section)).toContain('allergies')
    const sh = ragSectionHit(hit, 'retrieve')
    expect(sh.score).toBe(1)
    expect(sh.missingSections).toEqual([])
  })

  it('stuff mode has no retrieval step → section_hit is null', () => {
    expect(ragSectionHit(miss, 'stuff').score).toBeNull()
    expect(ragSectionHit(hit, 'stuff').score).toBeNull()
  })
})

describe('authoring gate rejects a k < requiredSections config error', () => {
  it('throws on a case that requires more sections than k', () => {
    const bad: RagBenchCase = {
      ...hit,
      caseId: 'rag-bad-config',
      k: 1,
      requiredSections: ['allergies', 'medications'], // 2 > k=1
    }
    expect(() => validateRagCase(bad)).toThrow(/config error/i)
  })
})

describe('non-selective honesty (small patient)', () => {
  it('the small-patient case is flagged non-selective and still hits', () => {
    expect(hit.nonSelective).toBe(true)
    // Retrieval returned ~the whole record (k ≈ corpus size).
    expect(hit.retrievedChunks.length).toBe(hit.fullRecord.length)
    expect(isBudgetTrimmed(hit)).toBe(false)
  })

  it('the ranking demonstrator (6 MB patient) is NOT non-selective', () => {
    expect(miss.nonSelective).toBe(false)
  })
})

describe('ingest chunk-count histogram', () => {
  it('emits a distribution (not a "6–9" point claim) covering the corpus', () => {
    expect(INGEST_CHUNK_HISTOGRAM.length).toBeGreaterThan(1)
    expect(INGEST_HISTOGRAM_TOTAL).toBe(25)
  })

  it('carries the 33+ outlier bucket (the 6 MB patient, snapshot-verified)', () => {
    const outlier = INGEST_CHUNK_HISTOGRAM.find((b) => b.range === '33+')
    expect(outlier).toBeTruthy()
    expect(outlier!.patients).toBe(1)
  })
})

describe('RAG-term glossary (G4 tooltips)', () => {
  it('defines the RAG plumbing terms', () => {
    for (const t of ['stuff', 'retrieve', 'k', 'distance', 'similarity', 'inBudget']) {
      expect(RAG_TERMS[t]).toBeTruthy()
    }
  })

  it('section_hit gloss carries specialist copy #94 verbatim', () => {
    expect(RAG_TERMS['section_hit']).toContain(
      'section_hit is a coarse, section-level recall signal',
    )
  })
})
