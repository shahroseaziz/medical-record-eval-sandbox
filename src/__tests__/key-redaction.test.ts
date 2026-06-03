/**
 * Assertions that the BYO API key header never reaches any log sink.
 *
 * Two parts:
 * 1. Static grep over API route source files — no console.* call may reference
 *    the header name alongside a value that could contain the key.
 * 2. Unit tests for the redact utility used by any future structured logger.
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import * as path from 'node:path'
import { redactHeaders, maskApiKey, SENSITIVE_HEADERS } from '@/lib/redact'

describe('BYO key never appears in log statements (grep)', () => {
  const apiDir = path.resolve(__dirname, '../../src/app/api')

  it('no console.* call in API routes references the key header', () => {
    let output = ''
    try {
      output = execSync(`grep -rn "console\\." ${apiDir} --include="*.ts"`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch {
      // exit code 1 means no matches — that is the ideal case
      output = ''
    }

    const logLines = output
      .split('\n')
      .filter((l) => l.includes('console.'))

    for (const line of logLines) {
      expect(line.toLowerCase()).not.toContain('x-byo-api-key')
      expect(line.toLowerCase()).not.toContain('byo-api-key')
    }
  })

  it('x-byo-api-key only appears in safe contexts across the whole src tree', () => {
    // Acceptable files: middleware, redact utility, route files (header read/write only),
    // client component that sends the header, and test files.
    const safePattern = /middleware\.ts|redact\.ts|route\.ts|__tests__|\.test\.ts|ApiKeyInput\.tsx/

    let output = ''
    try {
      const srcDir = path.resolve(__dirname, '../../src')
      output = execSync(
        `grep -rn "x-byo-api-key" ${srcDir} --include="*.ts" --include="*.tsx" -i`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch {
      output = ''
    }

    const lines = output.split('\n').filter(Boolean)
    for (const line of lines) {
      expect(safePattern.test(line)).toBe(true)
    }
  })
})

describe('redact utility', () => {
  it('SENSITIVE_HEADERS includes x-byo-api-key', () => {
    expect(SENSITIVE_HEADERS).toContain('x-byo-api-key')
  })

  it('redactHeaders masks the BYO key header', () => {
    const headers = {
      'content-type': 'application/json',
      'x-byo-api-key': 'sk-ant-abcdef123456',
    }
    const redacted = redactHeaders(headers)
    expect(redacted['x-byo-api-key']).toBe('[REDACTED]')
    expect(redacted['content-type']).toBe('application/json')
  })

  it('redactHeaders leaves headers without the key unchanged', () => {
    const headers = { 'content-type': 'application/json', accept: '*/*' }
    expect(redactHeaders(headers)).toEqual(headers)
  })

  it('maskApiKey shows prefix and suffix only', () => {
    const masked = maskApiKey('sk-ant-abcdef123456789')
    expect(masked).toMatch(/^sk-ant\.\.\./)
    expect(masked).not.toContain('abcdef')
  })

  it('maskApiKey returns [REDACTED] for very short keys', () => {
    expect(maskApiKey('short')).toBe('[REDACTED]')
  })
})
