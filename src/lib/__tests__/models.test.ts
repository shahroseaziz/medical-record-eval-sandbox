import { describe, it, expect } from 'vitest'
import {
  BYO_MODEL,
  GENERATION_MODEL,
  MODEL_IDS,
  modelDisplayName,
} from '@/lib/models'

describe('models single-source (SHA-156 N6)', () => {
  it('pins BYO_MODEL to claude-sonnet-4-6 and includes it in MODEL_IDS', () => {
    expect(BYO_MODEL).toBe('claude-sonnet-4-6')
    expect(MODEL_IDS).toContain(BYO_MODEL)
  })

  it('derives a human-facing label from the pinned id (no literal at the call site)', () => {
    expect(modelDisplayName(GENERATION_MODEL)).toBe('Haiku 4.5')
    expect(modelDisplayName(BYO_MODEL)).toBe('Sonnet 4.6')
    // a trailing date snapshot is excluded from the version
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    // unknown shapes fall back to the raw id
    expect(modelDisplayName('voyage-3.5')).toBe('voyage-3.5')
  })
})
