/**
 * evals/example-integrity-gate.ts — worked-example artifact INTEGRITY gate (N13b).
 *
 * The committed worked example (`example/notebook-example.json`) is a load-bearing
 * teaching fixture: the N13b loader replays it client-side as the canonical "this is
 * what an eval looks like" walkthrough. This gate keeps it honest. It is fully
 * DETERMINISTIC (no DB, no model call, no network) so it runs in the ordinary CI job.
 *
 * It asserts, over the COMMITTED BYTES:
 *   1. the artifact parses into the expected shape (`parseExampleArtifact`);
 *   2. BOTH legs are present and non-empty;
 *   3. ≥1 golden row FAILS its golden (the "a mismatch is a lead" teaching moment);
 *   4. ≥1 judge verdict is ERRORED (the "judge errored — not scored" teaching moment);
 *   5. the artifact's content sha256 MATCHES the committed `.sha256` sidecar — a hash
 *      change WITHOUT an explicit bump commit (sidecar updated alongside) FAILS, which
 *      is what guards silent drift of the fixture.
 *
 * PENDING (not red): until the maintainer lands the real artifact via a live-engine
 * run (Desk-verified, like the N1 re-seed — see example/README.md), the file is
 * legitimately ABSENT. The gate then reports `pending` and exits 0 so CI is not
 * permanently red on an artifact engineers must NOT hand-author. The MOMENT the file
 * lands, every check above becomes load-bearing. The failure paths are exercised now
 * against synthetic/tmp fixtures in the gate's unit tests.
 *
 * Exit codes:  0 gate-green OR pending   ·   1 gate-red (integrity violation)
 *
 * Usage: npx tsx evals/example-integrity-gate.ts
 */

import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseExampleArtifact,
  failingGoldenCases,
  erroredVerdicts,
  ExampleArtifactError,
  EXAMPLE_ARTIFACT_PATH,
  EXAMPLE_SHA256_PATH,
} from '../src/app/notebook/example-artifact.js'

export const EXIT_GREEN = 0
export const EXIT_RED = 1

const REPO_ROOT = join(import.meta.dirname, '..')

export interface IntegrityViolation {
  check: string
  message: string
}

export type IntegrityStatus = 'green' | 'red' | 'pending'

export interface IntegrityResult {
  status: IntegrityStatus
  violations: IntegrityViolation[]
  /** Set when status is 'pending' (artifact not yet committed by the maintainer). */
  pendingReason?: string
}

export interface IntegrityGateOptions {
  artifactPath?: string
  sidecarPath?: string
}

/**
 * Parse the sha256 hex out of a `sha256sum`-format sidecar
 * (`<hex>␠␠example/notebook-example.json`). Returns null on a malformed sidecar.
 */
export function parseSidecarHash(sidecar: string): string | null {
  const token = sidecar.trim().split(/\s+/)[0]
  return token && /^[0-9a-f]{64}$/i.test(token) ? token.toLowerCase() : null
}

/**
 * Run the integrity gate against the committed artifact + sidecar (paths overridable
 * for tests). Pure: reads two files, never calls a model or a DB.
 */
export function runExampleIntegrityGate(opts: IntegrityGateOptions = {}): IntegrityResult {
  const artifactPath = opts.artifactPath ?? join(REPO_ROOT, EXAMPLE_ARTIFACT_PATH)
  const sidecarPath = opts.sidecarPath ?? join(REPO_ROOT, EXAMPLE_SHA256_PATH)
  const violations: IntegrityViolation[] = []

  // The artifact is a maintainer-committed, live-engine-verified fixture (NOT
  // engineer-fabricated). Absent → pending, not red.
  if (!existsSync(artifactPath)) {
    return {
      status: 'pending',
      violations: [],
      pendingReason:
        `Worked-example artifact not committed yet (${EXAMPLE_ARTIFACT_PATH}). It is produced once by ` +
        `a maintainer against the live engine and committed Desk-verified; this gate becomes load-bearing once it lands.`,
    }
  }

  const rawBytes = readFileSync(artifactPath, 'utf-8')

  // [1] Shape
  let artifact
  try {
    artifact = parseExampleArtifact(JSON.parse(rawBytes))
  } catch (err) {
    const message =
      err instanceof ExampleArtifactError || err instanceof Error
        ? err.message
        : 'Artifact did not parse'
    return { status: 'red', violations: [{ check: 'schema', message }] }
  }

  // [2] Both legs non-empty
  if (artifact.golden.cases.length === 0) {
    violations.push({ check: 'golden-leg', message: 'GOLDEN leg has no cases — a leg is missing.' })
  }
  if (artifact.judge.cases.length === 0) {
    violations.push({ check: 'judge-leg', message: 'JUDGE leg has no cases — a leg is missing.' })
  }

  // [3] ≥1 failing golden row
  if (artifact.golden.cases.length > 0 && failingGoldenCases(artifact.golden).length === 0) {
    violations.push({
      check: 'failing-golden',
      message:
        'No golden row FAILS its golden — the "a mismatch is a lead" teaching moment is missing. ' +
        'Change the patient selection until the live model genuinely gets one wrong (never edit a golden).',
    })
  }

  // [4] ≥1 errored verdict
  if (artifact.judge.cases.length > 0 && erroredVerdicts(artifact.judge).length === 0) {
    violations.push({
      check: 'errored-verdict',
      message:
        'No judge verdict is ERRORED — the "judge errored — not scored" teaching moment is missing.',
    })
  }

  // [5] sha256 of the committed bytes matches the sidecar (silent-drift guard)
  if (!existsSync(sidecarPath)) {
    violations.push({
      check: 'sidecar-missing',
      message: `sha256 sidecar not found (${EXAMPLE_SHA256_PATH}). Commit it alongside the artifact.`,
    })
  } else {
    const expected = parseSidecarHash(readFileSync(sidecarPath, 'utf-8'))
    if (!expected) {
      violations.push({
        check: 'sidecar-malformed',
        message: `sha256 sidecar is not in sha256sum format (${EXAMPLE_SHA256_PATH}).`,
      })
    } else {
      const actual = createHash('sha256').update(rawBytes).digest('hex')
      if (actual !== expected) {
        violations.push({
          check: 'sha256-mismatch',
          message:
            `Artifact sha256 ${actual.slice(0, 12)}… does not match the committed sidecar ${expected.slice(0, 12)}…. ` +
            'The fixture drifted without an explicit bump commit (regenerate via the maintainer flow, then commit ' +
            'the artifact AND the refreshed sidecar together).',
        })
      }
    }
  }

  return violations.length === 0 ? { status: 'green', violations: [] } : { status: 'red', violations }
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main(): void {
  process.stdout.write('worked-example integrity gate — evals/example-integrity-gate.ts\n')
  const result = runExampleIntegrityGate()

  if (result.status === 'pending') {
    process.stdout.write(`  ~  pending: ${result.pendingReason ?? ''}\n`)
    process.exit(EXIT_GREEN)
  }
  if (result.status === 'green') {
    process.stdout.write('  ✓  gate-green: both legs present, ≥1 failing golden, ≥1 errored verdict, sha256 matches sidecar\n')
    process.exit(EXIT_GREEN)
  }
  process.stdout.write(`  ✗  gate-red: ${result.violations.length} violation(s)\n`)
  for (const v of result.violations) process.stdout.write(`       [${v.check}] ${v.message}\n`)
  process.exit(EXIT_RED)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
