import { describe, it, expect } from 'vitest'
import {
  canonicalizeDose,
  dosesMatch,
  normalizeName,
  collapseDuplicates,
} from '../scorers/structured-diff-normalization'

describe('canonicalizeDose — unit canonicalization', () => {
  it('parses value + mg', () => {
    const d = canonicalizeDose('500 mg')
    expect(d.parseable).toBe(true)
    expect(d.canonicalUnit).toBe('mg')
    expect(d.value).toBe(500)
  })

  it('converts grams to mg', () => {
    expect(canonicalizeDose('0.5 g').value).toBe(500)
    expect(canonicalizeDose('0.5 g').canonicalUnit).toBe('mg')
  })

  it('converts micrograms to mg', () => {
    expect(canonicalizeDose('500 mcg').value).toBe(0.5)
    expect(canonicalizeDose('500 µg').value).toBe(0.5)
    expect(canonicalizeDose('500 ug').value).toBe(0.5)
  })

  it('handles spelled-out unit aliases', () => {
    expect(canonicalizeDose('500 milligrams').canonicalUnit).toBe('mg')
    expect(canonicalizeDose('5 milliliters').canonicalUnit).toBe('mL')
  })

  it('strips thousands separators in the value', () => {
    expect(canonicalizeDose('1,000 mcg').value).toBe(1)
  })

  it('handles leading-dot decimals', () => {
    expect(canonicalizeDose('.5 g').value).toBe(500)
  })

  it('marks an unparseable dose', () => {
    const d = canonicalizeDose('as directed')
    expect(d.parseable).toBe(false)
    expect(d.value).toBeNull()
    expect(d.canonicalUnit).toBeNull()
    expect(d.normalizedText).toBe('as directed')
  })

  it('marks an unknown unit as unparseable', () => {
    expect(canonicalizeDose('5 widgets').parseable).toBe(false)
  })

  it('alias-normalizes each side of a compound unit but does not convert magnitude', () => {
    const d = canonicalizeDose('10 mg/mL')
    expect(d.parseable).toBe(true)
    expect(d.canonicalUnit).toBe('mg/mL')
    expect(d.value).toBe(10)
  })
})

describe('dosesMatch', () => {
  it('matches equal magnitudes across unit spellings', () => {
    expect(dosesMatch(canonicalizeDose('500 mg'), canonicalizeDose('0.5 g'))).toBe(true)
    expect(dosesMatch(canonicalizeDose('500 mcg'), canonicalizeDose('0.5 mg'))).toBe(true)
  })

  it('does not match across dimensions', () => {
    expect(dosesMatch(canonicalizeDose('5 mg'), canonicalizeDose('5 mL'))).toBe(false)
  })

  it('does not match different magnitudes', () => {
    expect(dosesMatch(canonicalizeDose('500 mg'), canonicalizeDose('250 mg'))).toBe(false)
  })

  it('falls back to text equality when unparseable', () => {
    expect(dosesMatch(canonicalizeDose('as directed'), canonicalizeDose('As Directed'))).toBe(true)
    expect(dosesMatch(canonicalizeDose('as directed'), canonicalizeDose('per sliding scale'))).toBe(
      false,
    )
  })

  it('compound units match on both value and per-side aliases', () => {
    expect(dosesMatch(canonicalizeDose('10 mg/mL'), canonicalizeDose('10 mg/ml'))).toBe(true)
  })
})

describe('normalizeName — alias resolution', () => {
  it('lowercases and trims', () => {
    expect(normalizeName('  Metformin ')).toBe('metformin')
  })

  it('strips salt suffixes', () => {
    expect(normalizeName('Metformin HCl')).toBe('metformin')
    expect(normalizeName('Metformin hydrochloride')).toBe('metformin')
    expect(normalizeName('Amlodipine besylate')).toBe('amlodipine')
    expect(normalizeName('Metoprolol succinate')).toBe('metoprolol')
  })

  it('strips multiple trailing salt/hydrate tokens', () => {
    expect(normalizeName('Drugix sodium monohydrate')).toBe('drugix')
  })

  it('never strips the last remaining token', () => {
    expect(normalizeName('Sodium')).toBe('sodium')
  })

  it('collapses punctuation and whitespace', () => {
    expect(normalizeName('Co-Trimoxazole')).toBe('co trimoxazole')
  })
})

describe('collapseDuplicates — duplicate-name rule', () => {
  it('collapses exact duplicates (same name + same dose)', () => {
    const r = collapseDuplicates([
      { name: 'Metformin', dose: '500 mg' },
      { name: 'metformin', dose: '0.5 g' }, // same canonical name + dose
    ])
    expect(r.entries).toHaveLength(1)
    expect(r.duplicateNameGroups).toEqual([])
  })

  it('keeps distinct strengths but flags the name', () => {
    const r = collapseDuplicates([
      { name: 'Metformin', dose: '500 mg' },
      { name: 'Metformin', dose: '1000 mg' },
    ])
    expect(r.entries).toHaveLength(2)
    expect(r.duplicateNameGroups).toEqual(['metformin'])
  })

  it('treats a missing dose as its own bucket', () => {
    const r = collapseDuplicates([{ name: 'Metformin' }, { name: 'Metformin', dose: '500 mg' }])
    expect(r.entries).toHaveLength(2)
    expect(r.duplicateNameGroups).toEqual(['metformin'])
  })
})
