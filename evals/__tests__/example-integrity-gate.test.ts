/**
 * Tests for the worked-example artifact integrity gate (N13b).
 *
 * The committed artifact is a maintainer-owned, live-engine-verified fixture and is
 * deliberately ABSENT in the engineer build, so every assertion here runs against
 * SYNTHETIC artifacts written to a tmp dir (never the real file). This proves the
 * gate's logic — the four integrity failures + the green path + the absent→pending
 * path — without hand-authoring the load-bearing fixture.
 *
 * VERIFY matrix:
 *   ✓ green path: a valid artifact + matching sidecar → green
 *   ✓ absent artifact → pending (exit 0), never red
 *   ✓ FAILURE: a missing leg → red (golden-leg / judge-leg)
 *   ✓ FAILURE: no failing golden row → red (failing-golden)
 *   ✓ FAILURE: no errored verdict → red (errored-verdict)
 *   ✓ FAILURE: sha256 mismatch without a bump commit → red (sha256-mismatch)
 *   ✓ a matching sidecar after a content change (bump commit) → green again
 *   ✓ malformed bytes → red (schema); missing/malformed sidecar → red
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  runExampleIntegrityGate,
  parseSidecarHash,
} from '../example-integrity-gate.js'
import {
  serializeArtifact,
  EXAMPLE_SCHEMA_VERSION,
  EXAMPLE_ARTIFACT_PATH,
  type GoldenLegCase,
  type JudgeLegCase,
  type NotebookExampleArtifact,
} from '../../src/app/notebook/example-artifact.js'

const MODEL = 'claude-haiku-4-5-20251001'

function passingGolden(patientId: string): GoldenLegCase {
  const value = { a1c_current: 6.7, diabetes_meds: ['Metformin 500 MG'] }
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: JSON.stringify(value),
    model: MODEL,
    golden: JSON.stringify(value),
  }
}

function failingGolden(patientId: string): GoldenLegCase {
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: JSON.stringify({ a1c_current: 6.7 }),
    model: MODEL,
    golden: JSON.stringify({ a1c_current: 8.1, diabetes_meds: ['Metformin 500 MG'] }),
  }
}

function settledVerdict(patientId: string, pass: boolean): JudgeLegCase {
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: 'A written summary of the chart.',
    model: MODEL,
    verdict: { errored: false, pass, reason: 'Grounded in the criteria and the output.' },
    judgeModel: MODEL,
  }
}

function erroredVerdict(patientId: string): JudgeLegCase {
  return {
    patientId,
    patientName: `Patient ${patientId}`,
    output: 'A written summary of the chart.',
    model: MODEL,
    verdict: { errored: true },
    judgeModel: null,
  }
}

function artifact(golden: GoldenLegCase[], judge: JudgeLegCase[]): NotebookExampleArtifact {
  return {
    schemaVersion: EXAMPLE_SCHEMA_VERSION,
    description: 'synthetic integrity-gate fixture',
    generatedAt: '2026-06-17T00:00:00.000Z',
    models: { generation: MODEL, judge: MODEL },
    golden: { prompt: 'extract diabetes management', cases: golden },
    judge: { prompt: 'summarize the chart', criteria: 'pass if complete', cases: judge },
  }
}

/** A fully-valid artifact: both legs, ≥1 failing golden, ≥1 errored verdict. */
function validArtifact(): NotebookExampleArtifact {
  return artifact(
    [passingGolden('a'), failingGolden('b')],
    [settledVerdict('a', true), erroredVerdict('b')],
  )
}

/**
 * Write a synthetic artifact (+ optional sidecar) to a fresh tmp dir and run the
 * gate against it. A `sidecarHash` of 'match' writes the true sha256 (a bump
 * commit); any other string is written verbatim (a drifted/forged sidecar);
 * `null` omits the sidecar entirely.
 */
function gateOn(
  art: NotebookExampleArtifact | string,
  sidecarHash: 'match' | string | null = 'match',
) {
  const dir = mkdtempSync(join(tmpdir(), 'eig-'))
  const artifactPath = join(dir, 'notebook-example.json')
  const sidecarPath = join(dir, 'notebook-example.json.sha256')
  const bytes = typeof art === 'string' ? art : serializeArtifact(art)
  writeFileSync(artifactPath, bytes)
  if (sidecarHash !== null) {
    const hex = sidecarHash === 'match' ? createHash('sha256').update(bytes).digest('hex') : sidecarHash
    writeFileSync(sidecarPath, `${hex}  ${EXAMPLE_ARTIFACT_PATH}\n`)
  }
  try {
    return runExampleIntegrityGate({ artifactPath, sidecarPath })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('parseSidecarHash', () => {
  it('extracts the hex from sha256sum format', () => {
    const hex = 'a'.repeat(64)
    expect(parseSidecarHash(`${hex}  example/notebook-example.json\n`)).toBe(hex)
  })
  it('rejects a non-hex / wrong-length token', () => {
    expect(parseSidecarHash('not-a-hash  file')).toBeNull()
    expect(parseSidecarHash('abc  file')).toBeNull()
  })
})

describe('runExampleIntegrityGate — green & pending', () => {
  it('green: a valid artifact with a matching sidecar', () => {
    const result = gateOn(validArtifact(), 'match')
    expect(result.status).toBe('green')
    expect(result.violations).toHaveLength(0)
  })

  it('pending (not red): the artifact is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eig-absent-'))
    const result = runExampleIntegrityGate({
      artifactPath: join(dir, 'does-not-exist.json'),
      sidecarPath: join(dir, 'does-not-exist.json.sha256'),
    })
    rmSync(dir, { recursive: true, force: true })
    expect(result.status).toBe('pending')
    expect(result.violations).toHaveLength(0)
  })
})

describe('runExampleIntegrityGate — the four integrity failures', () => {
  it('FAILS on a missing leg (empty golden leg)', () => {
    const result = gateOn(artifact([], [erroredVerdict('a')]), 'match')
    expect(result.status).toBe('red')
    expect(result.violations.some((v) => v.check === 'golden-leg')).toBe(true)
  })

  it('FAILS on a missing leg (empty judge leg)', () => {
    const result = gateOn(artifact([failingGolden('a')], []), 'match')
    expect(result.status).toBe('red')
    expect(result.violations.some((v) => v.check === 'judge-leg')).toBe(true)
  })

  it('FAILS when no golden row fails (no failing golden)', () => {
    const result = gateOn(
      artifact([passingGolden('a'), passingGolden('b')], [settledVerdict('a', true), erroredVerdict('b')]),
      'match',
    )
    expect(result.status).toBe('red')
    expect(result.violations.some((v) => v.check === 'failing-golden')).toBe(true)
  })

  it('FAILS when no verdict is errored (no errored verdict)', () => {
    const result = gateOn(
      artifact([passingGolden('a'), failingGolden('b')], [settledVerdict('a', true), settledVerdict('b', false)]),
      'match',
    )
    expect(result.status).toBe('red')
    expect(result.violations.some((v) => v.check === 'errored-verdict')).toBe(true)
  })

  it('FAILS on a sha256 mismatch without a bump commit', () => {
    // A forged/stale sidecar hash: the artifact bytes were changed but the sidecar
    // was NOT updated alongside (no explicit bump commit).
    const result = gateOn(validArtifact(), 'b'.repeat(64))
    expect(result.status).toBe('red')
    expect(result.violations.some((v) => v.check === 'sha256-mismatch')).toBe(true)
  })

  it('green again once the sidecar is bumped to match the new content', () => {
    // Same artifact, sidecar recomputed to match (the bump commit) → green.
    const result = gateOn(validArtifact(), 'match')
    expect(result.status).toBe('green')
  })
})

describe('runExampleIntegrityGate — malformed inputs', () => {
  it('FAILS (schema) on bytes that do not parse into the artifact shape', () => {
    const result = gateOn('{"schemaVersion":"wrong"}', 'match')
    expect(result.status).toBe('red')
    expect(result.violations[0].check).toBe('schema')
  })

  it('FAILS on a missing sidecar', () => {
    const result = gateOn(validArtifact(), null)
    expect(result.status).toBe('red')
    expect(result.violations.some((v) => v.check === 'sidecar-missing')).toBe(true)
  })

  it('FAILS on a malformed (non-sha256sum) sidecar', () => {
    const result = gateOn(validArtifact(), 'not-a-valid-hash-token')
    expect(result.status).toBe('red')
    expect(result.violations.some((v) => v.check === 'sidecar-malformed')).toBe(true)
  })
})
