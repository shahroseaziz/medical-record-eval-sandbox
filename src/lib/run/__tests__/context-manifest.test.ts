import { describe, it, expect } from 'vitest'
import { buildContextManifest } from '../context-manifest'

describe('buildContextManifest', () => {
  it('retrieve mode reports one section per in-budget chunk with char counts', () => {
    const m = buildContextManifest({
      mode: 'retrieve',
      chunks: [
        { section: 'medications', text: 'Lisinopril 10mg daily' }, // 21 chars
        { section: 'problems', text: 'Hypertension' }, // 12 chars
      ],
    })
    expect(m.contextMode).toBe('retrieved')
    expect(m.sections).toEqual([
      { section: 'medications', chars: 21 },
      { section: 'problems', chars: 12 },
    ])
    expect(m.droppedSections).toBeUndefined()
  })

  it('retrieve mode surfaces deduped dropped sections in first-seen order', () => {
    const m = buildContextManifest({
      mode: 'retrieve',
      chunks: [{ section: 'medications', text: 'x' }],
      droppedSections: ['labs', 'imaging', 'labs'],
    })
    expect(m.droppedSections).toEqual(['labs', 'imaging'])
  })

  it('omits droppedSections when nothing was dropped', () => {
    const m = buildContextManifest({
      mode: 'retrieve',
      chunks: [{ section: 'medications', text: 'x' }],
      droppedSections: [],
    })
    expect(m.droppedSections).toBeUndefined()
  })

  it('stuff mode reports the whole record as a single section', () => {
    const m = buildContextManifest({ mode: 'stuff', chunks: [], record: 'abcde' })
    expect(m.contextMode).toBe('full')
    expect(m.sections).toEqual([{ section: 'record', chars: 5 }])
    expect(m.droppedSections).toBeUndefined()
  })

  it('stuff mode tolerates an absent record (chars 0)', () => {
    const m = buildContextManifest({ mode: 'stuff', chunks: [] })
    expect(m.sections).toEqual([{ section: 'record', chars: 0 }])
  })
})
