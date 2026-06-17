import { describe, it, expect } from 'vitest'
import {
  SCHEMA_VERSION,
  createEmptyState,
  serializeState,
  importState,
  safeImportState,
  projectSimpleTrail,
  projectOnlyTrail,
  projectEvalTrail,
  scoredEvalKeys,
  type NotebookState,
  type NotebookRun,
  type ScoreRow,
} from '../state'

/**
 * A fully populated, schema-valid state covering every axis of the (run, eval,
 * patient) cube: a golden eval, a judge eval (with `agree` markers), one run with
 * two patients, and a score row per eval. Used to exercise round-trip + rejection.
 */
function fullState(): NotebookState {
  return {
    schemaVersion: SCHEMA_VERSION,
    runs: [
      {
        id: 'run-1',
        version: 1,
        promptText: 'Summarize the active medications.',
        promptHash: 'sha256:abc123',
        createdAt: '2026-06-16T00:00:00.000Z',
        outputs: {
          'patient-a': {
            json: { medications: ['Lisinopril 10mg'] },
            model: 'claude-opus-4-8',
            contextMode: 'full',
            sections: ['medications'],
            status: 'ok',
          },
          'patient-b': {
            text: 'No medications documented.',
            model: 'claude-opus-4-8',
            contextMode: 'retrieved',
            sections: ['medications', 'problems'],
            status: 'ok',
          },
        },
      },
    ],
    evals: [
      {
        key: 'golden',
        label: 'Golden set',
        version: 2,
        criteriaOrGolden: 'Active medications must match the source list exactly.',
        history: [
          { version: 1, contentHash: 'h1' },
          { version: 2, contentHash: 'h2' },
        ],
      },
      {
        key: 'judge:faithfulness',
        label: 'Faithfulness judge',
        version: 1,
        criteriaOrGolden: 'Every claim must be grounded in the provided context.',
        history: [{ version: 1, contentHash: 'j1' }],
      },
    ],
    scores: {
      golden: {
        'run-1': {
          frac: '1/2',
          per: [
            { patientId: 'patient-a', pass: true, fails: [] },
            { patientId: 'patient-b', pass: false, fails: ['medications'], reason: 'missed dose' },
          ],
        },
      },
      'judge:faithfulness': {
        'run-1': {
          frac: '2/2',
          per: [
            { patientId: 'patient-a', state: 'grounded', fails: [], agree: 'a' },
            { patientId: 'patient-b', state: 'grounded', fails: [], agree: 'm' },
          ],
        },
      },
    },
    meta: { modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' },
  }
}

describe('notebook bench-state v1', () => {
  // (a) export → import round-trip preserves the object.
  it('round-trips a full state through export → import', () => {
    const state = fullState()
    const exported = serializeState(state)
    const reimported = importState(exported)
    expect(reimported).toEqual(state)
  })

  it('round-trips an empty state', () => {
    const empty = createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' })
    expect(importState(serializeState(empty))).toEqual(empty)
  })

  // (b) a malformed import throws / returns an error and loads NOTHING.
  describe('rejects malformed imports with no partial load', () => {
    it('throws on a wrong schemaVersion', () => {
      const bad = { ...fullState(), schemaVersion: 'bench.v0' }
      expect(() => importState(bad)).toThrow()
      const safe = safeImportState(bad)
      expect(safe.ok).toBe(false)
      if (!safe.ok) expect(safe.error).toMatch(/reject/i)
    })

    it('throws on a missing required field', () => {
      const bad = fullState() as Record<string, unknown>
      delete bad.runs
      expect(() => importState(bad)).toThrow()
    })

    it('throws on a wrong-typed field and returns no state', () => {
      const bad = fullState() as unknown as Record<string, unknown>
      ;(bad.scores as Record<string, unknown>).golden = 'not-an-object'
      const safe = safeImportState(bad)
      expect(safe.ok).toBe(false)
      expect(safe).not.toHaveProperty('state')
    })

    it('throws on an invalid evalKey', () => {
      const bad = fullState()
      bad.evals[0].key = 'not-golden-not-judge'
      expect(() => importState(bad)).toThrow()
    })

    it('throws on an invalid contextMode', () => {
      const bad = fullState() as unknown as { runs: { outputs: Record<string, { contextMode: string }> }[] }
      bad.runs[0].outputs['patient-a'].contextMode = 'partial'
      expect(() => importState(bad as unknown)).toThrow()
    })

    it('rejects invalid JSON strings', () => {
      const safe = safeImportState('{not json')
      expect(safe.ok).toBe(false)
      if (!safe.ok) expect(safe.error).toMatch(/json/i)
    })
  })

  // (c) the 1×1 projection equals the simple-trail shape — asserted on the ACTUAL
  // module export (the real projection helper), not hand-injected data.
  describe('simple trail is a projection of one scores row', () => {
    it('the 1×1 projection equals the single scores row', () => {
      // A genuinely 1×1 state: one eval, one run, one score row.
      const state: NotebookState = {
        ...createEmptyState(),
        runs: [
          {
            id: 'run-1',
            version: 1,
            promptText: 'p',
            promptHash: 'h',
            createdAt: '2026-06-16T00:00:00.000Z',
            outputs: {
              'patient-a': {
                text: 'out',
                model: 'claude-opus-4-8',
                contextMode: 'full',
                sections: ['medications'],
                status: 'ok',
              },
            },
          },
        ],
        evals: [
          {
            key: 'golden',
            label: 'Golden set',
            version: 1,
            criteriaOrGolden: 'criteria',
            history: [{ version: 1, contentHash: 'h1' }],
          },
        ],
        scores: {
          golden: {
            'run-1': {
              frac: '1/1',
              per: [{ patientId: 'patient-a', pass: true, fails: [] }],
            },
          },
        },
      }

      // Validate through the real schema so we project a known-valid object.
      const validated = importState(serializeState(state))

      const expectedRow: ScoreRow = validated.scores.golden['run-1']
      const projected = projectSimpleTrail(validated, 'golden', 'run-1')
      const onlyProjected = projectOnlyTrail(validated)

      // The projection IS the scores row — same object identity, same shape.
      expect(projected).toBe(expectedRow)
      expect(onlyProjected).toBe(expectedRow)

      // And it has the simple-trail shape: a frac string + per-patient array.
      expect(projected).toEqual({
        frac: '1/1',
        per: [{ patientId: 'patient-a', pass: true, fails: [] }],
      })
      expect(typeof projected?.frac).toBe('string')
      expect(Array.isArray(projected?.per)).toBe(true)
    })

    it('projectOnlyTrail is undefined when the cube is not 1×1', () => {
      // The full fixture has two evals → not a 1×1 cube.
      const validated = importState(serializeState(fullState()))
      expect(projectOnlyTrail(validated)).toBeUndefined()
      // But an explicit (eval, run) projection still works on the larger cube.
      expect(projectSimpleTrail(validated, 'golden', 'run-1')).toBe(
        validated.scores.golden['run-1'],
      )
    })

    it('projectSimpleTrail returns undefined for a missing cell', () => {
      const validated = importState(serializeState(fullState()))
      expect(projectSimpleTrail(validated, 'judge:nope', 'run-1')).toBeUndefined()
      expect(projectSimpleTrail(validated, 'golden', 'run-404')).toBeUndefined()
    })
  })

  // (d) the score-line eval-ROW trail: the last N scored runs for one eval, in
  // state.runs order (prev → current). A projection of the cube, not a copy.
  describe('eval-row trail projection (the simple score line)', () => {
    // A four-run state where `golden` is scored on three of the four runs (run-2
    // skipped) so the trail must respect run order AND skip unscored runs.
    function multiRunState(): NotebookState {
      const mkRun = (id: string, version: number): NotebookRun => ({
        id,
        version,
        promptText: 'p' + version,
        promptHash: 'h' + version,
        createdAt: `2026-06-1${version}T00:00:00.000Z`,
        outputs: {
          'patient-a': {
            text: 'out',
            model: 'claude-opus-4-8',
            contextMode: 'full',
            sections: ['medications'],
            status: 'ok',
          },
        },
      })
      const mkRow = (n: number): ScoreRow => ({
        frac: `${n}/1`,
        per: [{ patientId: 'patient-a', pass: n === 1, fails: [] }],
      })
      return {
        ...createEmptyState({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' }),
        runs: [mkRun('run-1', 1), mkRun('run-2', 2), mkRun('run-3', 3), mkRun('run-4', 4)],
        evals: [
          {
            key: 'golden',
            label: 'Golden set',
            version: 1,
            criteriaOrGolden: 'criteria',
            history: [{ version: 1, contentHash: 'h1' }],
          },
        ],
        // run-2 deliberately has no golden cell.
        scores: {
          golden: {
            'run-1': mkRow(1),
            'run-3': mkRow(0),
            'run-4': mkRow(1),
          },
        },
      }
    }

    it('returns the last 3 scored runs in run order, prev → current', () => {
      const state = importState(serializeState(multiRunState()))
      const trail = projectEvalTrail(state, 'golden')
      // run-2 is unscored → skipped; run-1/3/4 remain, capped at 3, in order.
      expect(trail.map((s) => s.runId)).toEqual(['run-1', 'run-3', 'run-4'])
      expect(trail.map((s) => s.version)).toEqual([1, 3, 4])
      expect(trail.map((s) => s.frac)).toEqual(['1/1', '0/1', '1/1'])
      // The last step is the current run; the first is the earliest of the window.
      expect(trail[trail.length - 1].runId).toBe('run-4')
    })

    it('each step projects the actual cube cell (same object identity)', () => {
      const state = importState(serializeState(multiRunState()))
      const trail = projectEvalTrail(state, 'golden')
      expect(trail[0].row).toBe(state.scores.golden['run-1'])
      expect(trail[2].row).toBe(state.scores.golden['run-4'])
    })

    it('caps the window with an explicit limit, keeping the most recent', () => {
      const state = importState(serializeState(multiRunState()))
      const trail = projectEvalTrail(state, 'golden', 2)
      expect(trail.map((s) => s.runId)).toEqual(['run-3', 'run-4'])
    })

    it('is empty for an eval with no scored runs', () => {
      const state = importState(serializeState(multiRunState()))
      expect(projectEvalTrail(state, 'judge:none')).toEqual([])
    })

    it('a 1×1 cube projects a single-step trail (prev === current)', () => {
      const validated = importState(serializeState(fullState()))
      const trail = projectEvalTrail(validated, 'golden')
      expect(trail).toHaveLength(1)
      expect(trail[0].frac).toBe('1/2')
      expect(trail[0].row).toBe(validated.scores.golden['run-1'])
    })

    it('scoredEvalKeys lists only evals that have scored runs', () => {
      const validated = importState(serializeState(fullState()))
      expect(scoredEvalKeys(validated)).toEqual(['golden', 'judge:faithfulness'])
      const empty = createEmptyState()
      expect(scoredEvalKeys(empty)).toEqual([])
    })
  })

  // (e) Export is the FULL cube + meta, round-tripped — never the trail subset.
  describe('export round-trips the full cube even from a trail-only UI', () => {
    it('serializeState → safeImportState preserves a 1×1 cube whole', () => {
      const state = fullState()
      const result = safeImportState(serializeState(state))
      expect(result.ok).toBe(true)
      if (result.ok) {
        // The whole cube survives: every run, eval, score cell, and meta field.
        expect(result.state).toEqual(state)
        expect(result.state.meta).toEqual({ modelIds: ['claude-opus-4-8'], appVersion: '0.1.0' })
        expect(Object.keys(result.state.scores)).toEqual(['golden', 'judge:faithfulness'])
      }
    })
  })
})
