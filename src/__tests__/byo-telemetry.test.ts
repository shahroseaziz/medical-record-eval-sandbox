/**
 * Regression tests for the judge-BYO telemetry fix (SHA-36).
 *
 * Bug: when judgeUsesByo=false but ANTHROPIC_API_KEY is absent, the judge
 * falls back to the caller's BYO key.  The stored judgeUsesByo flag was
 * derived from effectiveJudgeUsesByo (which ignored this fallback), so it
 * incorrectly reported false even though the BYO key was actually used.
 *
 * Fix: derive the stored flag from whether judgeKey === byoKey, not from
 * whether the caller requested BYO judge scoring.
 *
 * These tests import the production resolveJudgeKey() from its module so that
 * a regression in the route is caught here — testing a local replica would
 * leave the route's line 154 unexercised and give a false green.
 */

import { describe, it, expect } from 'vitest'
import { resolveJudgeKey } from '@/app/api/run/judge-key'

describe('judge-BYO telemetry — resolveJudgeKey()', () => {
  it('[BYO-FIX] flags keyIsByo=true when envKey absent and byoKey used as fallback', () => {
    // This is the exact bug scenario: caller has BYO key, env key is missing,
    // caller did NOT explicitly request BYO judge (judgeUsesByo=false).
    // The judge still uses BYO key (only option), so the stored flag must be true.
    const { judgeKey, judgeKeyIsByo } = resolveJudgeKey('byo-key', undefined, false)
    expect(judgeKey).toBe('byo-key')
    expect(judgeKeyIsByo).toBe(true)   // was false before the fix
  })

  it('flags keyIsByo=true when BYO judge explicitly requested', () => {
    const { judgeKey, judgeKeyIsByo } = resolveJudgeKey('byo-key', 'env-key', true)
    expect(judgeKey).toBe('byo-key')
    expect(judgeKeyIsByo).toBe(true)
  })

  it('flags keyIsByo=false when env key is used (BYO available but not requested)', () => {
    const { judgeKey, judgeKeyIsByo } = resolveJudgeKey('byo-key', 'env-key', false)
    expect(judgeKey).toBe('env-key')
    expect(judgeKeyIsByo).toBe(false)
  })

  it('flags keyIsByo=false when no BYO key is provided', () => {
    const { judgeKey, judgeKeyIsByo } = resolveJudgeKey(undefined, 'env-key', false)
    expect(judgeKey).toBe('env-key')
    expect(judgeKeyIsByo).toBe(false)
  })

  it('returns null key when neither BYO nor env key is present', () => {
    const { judgeKey, judgeKeyIsByo } = resolveJudgeKey(undefined, undefined, false)
    expect(judgeKey).toBeNull()
    expect(judgeKeyIsByo).toBe(false)
  })

  it('BYO not requested, BYO available, env absent — correctly reports BYO used (the regression case)', () => {
    // This is the key regression: previously effectiveJudgeUsesByo was stored directly,
    // which gave false here even though the judge ran with the BYO key.
    const byoKey = 'caller-key'
    const envKey = undefined

    // Pre-fix behavior (shows the old bug): effectiveJudgeUsesByo = false even though BYO key used
    const effectiveJudgeUsesByo = Boolean(false && byoKey) // = false (the buggy stored value)
    expect(effectiveJudgeUsesByo).toBe(false)

    // Post-fix behavior: resolveJudgeKey correctly reflects what actually happened
    const { judgeKeyIsByo } = resolveJudgeKey(byoKey, envKey, false)
    expect(judgeKeyIsByo).toBe(true) // correctly reflects what actually happened
  })
})
