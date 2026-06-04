/**
 * Negative-path unit tests for the eval gate.
 *
 * These exercise the detection helpers exported from run_evals.ts using
 * injected data — no live API calls, no filesystem I/O.
 *
 * VERIFY matrix (from task spec):
 *   ✓ injected judge model mismatch → gate-red
 *   ✓ injected embedding model mismatch → gate-red
 *   ✓ in-band seed case (score on wrong side of threshold) → gate-red
 *   ✓ judge_kappa_min floor breach → gate-red
 *   ✓ under-extraction (zeroClaimFlag on seeded case) → gate-red
 *   ✓ score outside tolerance band → gate-red
 *   ✓ passRate mismatch → gate-red
 *   ✓ outage simulation → isUpstreamOutage returns true → gate-inconclusive
 *   ✓ no violation → checks return null → gate-green path
 */

import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { writeFileSync, unlinkSync, mkdtempSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EXPECTED_JUDGE_MODEL,
  EXPECTED_EMBEDDING_MODEL,
  checkModelGuards,
  checkKappaFloor,
  checkScoreTolerance,
  checkInBand,
  checkUnderExtraction,
  checkPassRateExact,
  isUpstreamOutage,
  runGate,
  type GateViolation,
} from '../run_evals.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function baselineHead(overrides: Record<string, unknown> = {}) {
  return {
    judgeModel: EXPECTED_JUDGE_MODEL,
    embeddingModel: EXPECTED_EMBEDDING_MODEL,
    ...overrides,
  }
}

function baselineAggregate(overrides: Record<string, unknown> = {}) {
  return {
    passRate: 0.75,
    n: 4,
    note: 'directional, n=6-8',
    judgeHumanKappa: 0.883,
    ...overrides,
  }
}

// ── [1] Model guard ───────────────────────────────────────────────────────────

describe('checkModelGuards', () => {
  it('passes when both models match', () => {
    expect(
      checkModelGuards(
        baselineHead(),
        EXPECTED_JUDGE_MODEL,
        EXPECTED_EMBEDDING_MODEL
      )
    ).toBeNull()
  })

  it('gate-red on judge model swap', () => {
    const v = checkModelGuards(
      baselineHead({ judgeModel: 'claude-sonnet-4-6' }),
      EXPECTED_JUDGE_MODEL,
      EXPECTED_EMBEDDING_MODEL
    )
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('model-guard')
    expect((v as GateViolation).message).toMatch(/judge model mismatch/i)
  })

  it('gate-red on embedding model swap', () => {
    const v = checkModelGuards(
      baselineHead({ embeddingModel: 'voyage-3-lite' }),
      EXPECTED_JUDGE_MODEL,
      EXPECTED_EMBEDDING_MODEL
    )
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('embedding-guard')
    expect((v as GateViolation).message).toMatch(/embedding model mismatch/i)
  })
})

// ── [2] Kappa floor ───────────────────────────────────────────────────────────

describe('checkKappaFloor', () => {
  it('passes when kappa is above the floor', () => {
    expect(checkKappaFloor(baselineAggregate({ judgeHumanKappa: 0.7 }), 0.4)).toBeNull()
  })

  it('gate-red when kappa is below the floor', () => {
    const v = checkKappaFloor(baselineAggregate({ judgeHumanKappa: 0.3 }), 0.4)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('kappa-floor')
    expect((v as GateViolation).message).toMatch(/floor breach/i)
  })

  it('gate-red when judgeHumanKappa is null', () => {
    const v = checkKappaFloor(baselineAggregate({ judgeHumanKappa: null }), 0.4)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('kappa-floor')
  })

  it('gate-red when judgeHumanKappa is absent', () => {
    const agg = { passRate: 0.75, n: 4, note: 'directional, n=6-8' }
    const v = checkKappaFloor(agg, 0.4)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('kappa-floor')
  })

  it('passes when kappa exactly equals the floor', () => {
    expect(checkKappaFloor(baselineAggregate({ judgeHumanKappa: 0.4 }), 0.4)).toBeNull()
  })
})

// ── [3] Score tolerance ───────────────────────────────────────────────────────

describe('checkScoreTolerance', () => {
  it('passes when fresh score equals baseline', () => {
    expect(checkScoreTolerance('case-1', 0.9, 0.9, 0)).toBeNull()
  })

  it('passes when delta is within 0.05 minimum band', () => {
    expect(checkScoreTolerance('case-1', 0.95, 0.91, 0)).toBeNull()  // delta=0.04 < 0.05
  })

  it('gate-red when delta exceeds 0.05 minimum band', () => {
    const v = checkScoreTolerance('case-1', 0.80, 0.92, 0)  // delta=0.12 > 0.05
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('score-tolerance')
  })

  it('uses 3·stddev when it exceeds 0.05', () => {
    // stddev=0.02 → 3*0.02=0.06 → tolerance=0.06
    // delta=0.055 < 0.06 → should pass
    expect(checkScoreTolerance('case-1', 0.955, 0.9, 0.02)).toBeNull()
  })

  it('gate-red when delta exceeds 3·stddev tolerance', () => {
    // stddev=0.02 → tolerance=0.06; delta=0.07 > 0.06 → fail
    const v = checkScoreTolerance('case-1', 0.97, 0.9, 0.02)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('score-tolerance')
  })
})

// ── [4] In-band invariant (injected in-band seed case) ───────────────────────

describe('checkInBand', () => {
  const THRESHOLD = 0.85

  it('passes when pass case is above threshold', () => {
    expect(checkInBand('case-1', 0.95, 'pass', THRESHOLD)).toBeNull()
  })

  it('passes when fail case is below threshold', () => {
    expect(checkInBand('case-1', 0.1, 'fail', THRESHOLD)).toBeNull()
  })

  it('gate-red when pass case score falls at or below threshold', () => {
    const v = checkInBand('case-1', 0.85, 'pass', THRESHOLD)  // exactly at threshold → in-band
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('in-band')
    expect((v as GateViolation).message).toMatch(/referenceLabel=pass/i)
  })

  it('gate-red when fail case score is at or above threshold', () => {
    const v = checkInBand('case-1', 0.85, 'fail', THRESHOLD)  // exactly at threshold → in-band
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('in-band')
    expect((v as GateViolation).message).toMatch(/referenceLabel=fail/i)
  })

  it('gate-red when injected in-band fail case has high score', () => {
    // Simulate a fail case that somehow scored 0.95 (should be < 0.85)
    const v = checkInBand('faith-brenna-hallucinated-labs-stuff-fail', 0.95, 'fail', THRESHOLD)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('in-band')
  })
})

// ── [5] Under-extraction ──────────────────────────────────────────────────────

describe('checkUnderExtraction', () => {
  it('passes when claims were extracted', () => {
    expect(checkUnderExtraction('case-1', false)).toBeNull()
  })

  it('gate-red on zeroClaimFlag (under-extraction)', () => {
    const v = checkUnderExtraction('faith-agustin-problems-retrieve-pass', true)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('under-extraction')
    expect((v as GateViolation).message).toMatch(/0 claims/i)
  })
})

// ── [6] Aggregate passRate exact ─────────────────────────────────────────────

describe('checkPassRateExact', () => {
  it('passes when passCount and n match', () => {
    // baseline: passRate=0.75, n=4 → baselinePassCount=3
    expect(checkPassRateExact(3, 4, 0.75, 4)).toBeNull()
  })

  it('gate-red when passCount differs', () => {
    // baseline expects 3/4; fresh got 2/4
    const v = checkPassRateExact(2, 4, 0.75, 4)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('passrate-exact')
    expect((v as GateViolation).message).toMatch(/passrate mismatch/i)
  })

  it('gate-red when n differs', () => {
    const v = checkPassRateExact(3, 5, 0.75, 4)
    expect(v).not.toBeNull()
    expect((v as GateViolation).check).toBe('passrate-exact')
    expect((v as GateViolation).message).toMatch(/n mismatch/i)
  })

  it('skips check when baselinePassRate is null', () => {
    expect(checkPassRateExact(0, 0, null, 0)).toBeNull()
  })
})

// ── [7] Outage simulation ─────────────────────────────────────────────────────

const mockHeaders = new Headers()

describe('isUpstreamOutage', () => {
  it('returns true for Anthropic APIConnectionError', () => {
    const err = new Anthropic.APIConnectionError({ message: 'connection refused' })
    expect(isUpstreamOutage(err)).toBe(true)
  })

  it('returns true for Anthropic InternalServerError 529 (overloaded)', () => {
    const err = new Anthropic.InternalServerError(529, {}, 'overloaded', mockHeaders)
    expect(isUpstreamOutage(err)).toBe(true)
  })

  it('returns true for Anthropic InternalServerError 503', () => {
    const err = new Anthropic.InternalServerError(503, {}, 'service unavailable', mockHeaders)
    expect(isUpstreamOutage(err)).toBe(true)
  })

  it('returns false for Anthropic BadRequestError 400 (code bug)', () => {
    const err = new Anthropic.BadRequestError(400, {}, 'bad request', mockHeaders)
    expect(isUpstreamOutage(err)).toBe(false)
  })

  it('returns false for Anthropic AuthenticationError 401', () => {
    const err = new Anthropic.AuthenticationError(401, {}, 'unauthorized', mockHeaders)
    expect(isUpstreamOutage(err)).toBe(false)
  })

  it('returns true for fetch-level network error (ECONNREFUSED)', () => {
    const err = new Error('ECONNREFUSED localhost:443')
    expect(isUpstreamOutage(err)).toBe(true)
  })

  it('returns true for Voyage 5xx error string', () => {
    const err = new Error('Voyage API error 503: Service Unavailable')
    expect(isUpstreamOutage(err)).toBe(true)
  })

  it('returns false for non-Error values', () => {
    expect(isUpstreamOutage(null)).toBe(false)
    expect(isUpstreamOutage(undefined)).toBe(false)
    expect(isUpstreamOutage('some string')).toBe(false)
  })

  it('returns false for a normal programming error', () => {
    expect(isUpstreamOutage(new TypeError('Cannot read property of null'))).toBe(false)
  })
})

// ── [8] runGate — outage simulation via injected probers ─────────────────────

describe('runGate — outage path', () => {
  it('returns inconclusive when Voyage probe fails', async () => {
    const prevVoyage = process.env.VOYAGE_API_KEY
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.VOYAGE_API_KEY = 'test-stub'
    process.env.ANTHROPIC_API_KEY = 'test-stub'
    try {
      const result = await runGate({
        voyageProber: async () => 'down',
      })
      expect(result.status).toBe('inconclusive')
      expect(result.violations).toHaveLength(0)
      expect(result.inconclusiveReason).toMatch(/voyage/i)
    } finally {
      process.env.VOYAGE_API_KEY = prevVoyage
      process.env.ANTHROPIC_API_KEY = prevAnthropic
    }
  })

  it('returns inconclusive when Claude probe fails', async () => {
    const prevVoyage = process.env.VOYAGE_API_KEY
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.VOYAGE_API_KEY = 'test-stub'
    process.env.ANTHROPIC_API_KEY = 'test-stub'
    try {
      const result = await runGate({
        voyageProber: async () => 'ok',
        anthropicProber: async () => 'down',
      })
      expect(result.status).toBe('inconclusive')
      expect(result.violations).toHaveLength(0)
      expect(result.inconclusiveReason).toMatch(/claude/i)
    } finally {
      process.env.VOYAGE_API_KEY = prevVoyage
      process.env.ANTHROPIC_API_KEY = prevAnthropic
    }
  })
})

// ── [9] runGate — injected model mismatch → static red before API ─────────────

describe('runGate — injected model mismatch', () => {
  it('returns gate-red with model-guard violation when judgeModel is wrong', async () => {
    // Write a temp baseline with wrong judgeModel to exercise the full runGate code path
    const tmpDir = mkdtempSync(join(tmpdir(), 'gate-model-test-'))
    const baselinePath = join(tmpDir, 'baseline.json')
    const casesPath = join(tmpDir, 'cases.json')

    writeFileSync(
      baselinePath,
      JSON.stringify({
        judgeModel: 'wrong-model-injected',   // intentionally wrong
        embeddingModel: EXPECTED_EMBEDDING_MODEL,
        k: 5,
        cases: [],
        aggregate: { passRate: null, n: 0, note: 'test', judgeHumanKappa: 0.9 },
      })
    )
    writeFileSync(casesPath, JSON.stringify([]))

    const apiCallCount = { n: 0 }
    const fakeClient = {
      messages: {
        create: async () => {
          apiCallCount.n++
          return { content: [] }
        },
      },
    } as unknown as Anthropic

    const prevVoyage = process.env.VOYAGE_API_KEY
    const prevAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.VOYAGE_API_KEY = 'test-stub'
    process.env.ANTHROPIC_API_KEY = 'test-stub'
    try {
      const result = await runGate({
        anthropicClient: fakeClient,
        voyageProber: async () => 'ok',
        anthropicProber: async () => 'ok',
        baselinePath,
        casesPath,
      })

      expect(result.status).toBe('red')
      expect(result.violations.some((v) => v.check === 'model-guard')).toBe(true)
      // Model guard fires in static checks before any API call for scoring
      expect(apiCallCount.n).toBe(0)
    } finally {
      process.env.VOYAGE_API_KEY = prevVoyage
      process.env.ANTHROPIC_API_KEY = prevAnthropic
      try { unlinkSync(baselinePath) } catch { /* ignore */ }
      try { unlinkSync(casesPath) } catch { /* ignore */ }
      try { rmdirSync(tmpDir) } catch { /* ignore */ }
    }
  })
})
