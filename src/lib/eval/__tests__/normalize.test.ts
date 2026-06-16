import { describe, it, expect } from 'vitest'
import {
  normalizeValue,
  normalizeList,
  valuesMatch,
  gradeFields,
  aliasEntries,
} from '../normalize'

// ── Fixture table ─────────────────────────────────────────────────────────────
//
// This table SHIPS with the module and FAILS CLOSED: a wrong or missing alias
// makes a row red rather than silently producing a false user-facing verdict.
// It covers, per the SHA-155 acceptance:
//   • ≥1 exact-match case
//   • ≥1 case per alias (generated from the dictionary itself, below)
//   • ≥1 list-order-independent case
//   • near-miss NEGATIVES that must NOT match ("QID" ≢ "once daily")

interface MatchFixture {
  desc: string
  golden: string | string[]
  model: string | string[]
  shouldMatch: boolean
}

const FIXTURES: MatchFixture[] = [
  // ── Exact-match (no alias involved) ──────────────────────────────────────────
  { desc: 'identical text', golden: 'Hypertension', model: 'Hypertension', shouldMatch: true },
  { desc: 'case-insensitive', golden: 'Hypertension', model: 'hypertension', shouldMatch: true },
  {
    desc: 'whitespace-collapsed',
    golden: 'Type 2   Diabetes',
    model: 'Type 2 Diabetes',
    shouldMatch: true,
  },

  // ── Alias expansion in context ───────────────────────────────────────────────
  {
    desc: 'frequency alias inside a full sig',
    golden: '500 mg PO BID',
    model: '500 mg by mouth twice daily',
    shouldMatch: true,
  },
  {
    desc: 'dotted abbreviation form',
    golden: 'q.d.',
    model: 'once daily',
    shouldMatch: true,
  },
  {
    desc: 'route alias only',
    golden: 'PO',
    model: 'by mouth',
    shouldMatch: true,
  },

  // ── List-order independence ──────────────────────────────────────────────────
  {
    desc: 'list compares order-independently',
    golden: ['aspirin', 'metformin', 'lisinopril'],
    model: ['lisinopril', 'aspirin', 'metformin'],
    shouldMatch: true,
  },
  {
    desc: 'list with aliases, reordered',
    golden: ['take PO', 'BID'],
    model: ['twice daily', 'take by mouth'],
    shouldMatch: true,
  },
  {
    desc: 'list with a missing element fails',
    golden: ['aspirin', 'metformin', 'lisinopril'],
    model: ['aspirin', 'metformin'],
    shouldMatch: false,
  },

  // ── Near-miss NEGATIVES (must NOT match) ─────────────────────────────────────
  { desc: 'QID ≢ once daily', golden: 'QID', model: 'once daily', shouldMatch: false },
  { desc: 'BID ≢ TID', golden: 'BID', model: 'TID', shouldMatch: false },
  { desc: 'QD ≢ QOD', golden: 'QD', model: 'QOD', shouldMatch: false },
  { desc: 'PO ≢ PR', golden: 'PO', model: 'PR', shouldMatch: false },
  { desc: 'by mouth ≢ by rectum', golden: 'by mouth', model: 'by rectum', shouldMatch: false },
  { desc: 'SC ≢ SL', golden: 'SC', model: 'SL', shouldMatch: false },
  {
    desc: 'unrelated text does not match',
    golden: 'Hypertension',
    model: 'Hyperlipidemia',
    shouldMatch: false,
  },
]

describe('golden-diff normalization — fixture table', () => {
  it.each(FIXTURES)('$desc', ({ golden, model, shouldMatch }) => {
    expect(valuesMatch(golden, model)).toBe(shouldMatch)
  })
})

// ── ≥1 case per alias — generated directly from the dictionary ─────────────────
describe('alias dictionary — every variant resolves to its canonical', () => {
  for (const entry of aliasEntries()) {
    for (const variant of entry.variants) {
      it(`"${variant}" ≡ "${entry.canonical}"`, () => {
        expect(normalizeValue(variant)).toBe(entry.canonical)
        expect(normalizeValue(variant.toUpperCase())).toBe(entry.canonical)
        expect(valuesMatch(variant, entry.canonical)).toBe(true)
      })
    }
  }
})

// ── Provenance discipline ──────────────────────────────────────────────────────
describe('alias dictionary — provenance', () => {
  it('every alias entry carries a non-empty provenance source', () => {
    for (const entry of aliasEntries()) {
      expect(entry.source.trim().length).toBeGreaterThan(0)
      expect(entry.canonical.trim().length).toBeGreaterThan(0)
      expect(entry.variants.length).toBeGreaterThan(0)
      for (const variant of entry.variants) {
        expect(variant.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('no alias variant maps to two different canonicals', () => {
    const seen = new Map<string, string>()
    for (const entry of aliasEntries()) {
      for (const variant of entry.variants) {
        const prior = seen.get(variant)
        expect(prior === undefined || prior === entry.canonical).toBe(true)
        seen.set(variant, entry.canonical)
      }
    }
  })
})

// ── normalizeValue / normalizeList units ───────────────────────────────────────
describe('normalizeValue', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeValue('  Once   Daily ')).toBe('once daily')
  })

  it('expands a multi-token sig with route + frequency', () => {
    expect(normalizeValue('1 tab PO QHS')).toBe('1 tab by mouth at bedtime')
  })

  it('leaves a numeric decimal untouched', () => {
    expect(normalizeValue('0.5 mg')).toBe('0.5 mg')
  })

  it('returns empty string for blank input', () => {
    expect(normalizeValue('   ')).toBe('')
  })
})

describe('normalizeList', () => {
  it('is order-independent and preserves duplicates as a multiset', () => {
    expect(normalizeList(['BID', 'PO', 'BID'])).toEqual(
      normalizeList(['PO', 'BID', 'BID']),
    )
    // duplicate preserved (multiset, not set)
    expect(normalizeList(['BID', 'BID'])).toEqual(['twice daily', 'twice daily'])
  })
})

// ── gradeFields contract ───────────────────────────────────────────────────────
describe('gradeFields', () => {
  it('passes a field when golden matches model after normalization', () => {
    const verdicts = gradeFields(
      { frequency: 'QD', route: 'PO' },
      { frequency: 'once daily', route: 'by mouth' },
    )
    expect(verdicts.every((v) => v.pass)).toBe(true)
  })

  it('does NOT grade fields absent from the golden', () => {
    const verdicts = gradeFields(
      { frequency: 'QD' },
      { frequency: 'once daily', extra: 'ungraded value' },
    )
    expect(verdicts.map((v) => v.field)).toEqual(['frequency'])
  })

  it('fails a golden field missing from the model', () => {
    const verdicts = gradeFields({ frequency: 'QD', route: 'PO' }, { frequency: 'once daily' })
    const route = verdicts.find((v) => v.field === 'route')!
    expect(route.pass).toBe(false)
    expect(route.modelNormalized).toBeNull()
  })

  it('grades list fields order-independently', () => {
    const verdicts = gradeFields(
      { meds: ['aspirin', 'metformin'] },
      { meds: ['metformin', 'aspirin'] },
    )
    expect(verdicts[0].pass).toBe(true)
  })

  it('fails a near-miss alias (QID ≢ once daily)', () => {
    const verdicts = gradeFields({ frequency: 'QID' }, { frequency: 'once daily' })
    expect(verdicts[0].pass).toBe(false)
  })
})
