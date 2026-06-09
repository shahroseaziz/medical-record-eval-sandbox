import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { diffForSource, loadLessonBeat1 } from '../beat1'

/**
 * Acceptance test for SHA-60 R8 — Beat 1 (correctness with a diff).
 *
 * The beat must (a) run the REAL deterministic structured diff against whichever
 * key the learner authors, landing both honest outcomes, and (b) genuinely run on
 * the SEEDED R7 generation — enforced here by a drift guard pinning the fixture's
 * model output and record-derived key to the committed seed case.
 */
describe('lesson Beat 1 — structured diff over an authored key', () => {
  const data = loadLessonBeat1()

  it('author from the summary → green diff against a WRONG reference (F1 = 1.0)', () => {
    const diff = diffForSource('summary')
    // The summary lists amlodipine 5 mg, which matches the model. Every field
    // agrees → a perfect-looking diff that is nonetheless graded against a wrong key.
    expect(diff.score).toBe(1)
    expect(diff.mismatchCount).toBe(0)
    expect(diff.missingCount).toBe(0)
    expect(diff.extraCount).toBe(0)
  })

  it('author from the record → catches the model dose error (F1 = 0.9167, one mismatch)', () => {
    const diff = diffForSource('record')
    expect(diff.score).toBeCloseTo(0.9167, 4)
    expect(diff.mismatchCount).toBe(1)
    const mism = diff.fields.find((f) => f.status === 'mismatch')
    expect(mism?.item).toBe('amlodipine')
    expect(mism?.expected).toBe('2.5 mg')
    expect(mism?.actual).toBe('5 mg')
  })

  it('the only difference between the two authored keys is the amlodipine dose', () => {
    const s = data.answerKeys.summary.medications
    const r = data.answerKeys.record.medications
    expect(s.map((m) => m.name)).toEqual(r.map((m) => m.name))
    const diffs = s.filter((m, i) => m.dose !== r[i].dose)
    expect(diffs).toHaveLength(1)
    expect(diffs[0].name).toBe('amlodipine')
  })

  it('runs on the SEEDED R7 generation: output + record key match the committed seed case', () => {
    const seed = JSON.parse(
      readFileSync(join(process.cwd(), 'evals/golden/seed-cases.json'), 'utf8'),
    ) as Array<{ id: string; preauthoredOutput?: string; expectedStructured?: unknown }>
    const lessonCase = seed.find((c) => c.id === 'lesson-marisela-medications-structured-diff')
    expect(lessonCase).toBeDefined()
    // The output the learner grades IS the R7 committed generation, byte-for-byte.
    expect(data.modelOutput).toBe(lessonCase!.preauthoredOutput)
    // The record-derived key IS the seed's hand-authored expected structured output.
    expect(data.answerKeys.record).toEqual(lessonCase!.expectedStructured)
  })

  it('is deterministic: the same source yields byte-identical diffs across calls', () => {
    expect(JSON.stringify(diffForSource('summary'))).toBe(JSON.stringify(diffForSource('summary')))
    expect(JSON.stringify(diffForSource('record'))).toBe(JSON.stringify(diffForSource('record')))
  })
})
