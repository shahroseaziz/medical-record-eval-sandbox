import { describe, it, expect } from 'vitest'
import {
  SCHEMA_VERSION,
  createEmptyState,
  serializeState,
  importState,
  safeImportState,
  projectSimpleTrail,
  projectOnlyTrail,
  type NotebookState,
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
})
