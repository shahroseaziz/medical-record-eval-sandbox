import { describe, it, expect } from 'vitest'
import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

describe('CSP middleware', () => {
  function makeReq(path = '/') {
    return new NextRequest(`http://localhost:3000${path}`)
  }

  it('sets Content-Security-Policy on every response', () => {
    const res = middleware(makeReq())
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy()
  })

  it("CSP includes default-src 'self'", () => {
    const csp = middleware(makeReq()).headers.get('Content-Security-Policy')!
    expect(csp).toContain("default-src 'self'")
  })

  it('CSP script-src does not allow any third-party domain', () => {
    const csp = middleware(makeReq()).headers.get('Content-Security-Policy')!
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? ''
    // No http:// or https:// domain references — only keywords like 'self' / 'unsafe-inline'
    expect(scriptSrc).not.toMatch(/https?:\/\//)
  })

  it("CSP blocks framing via frame-ancestors 'none'", () => {
    const csp = middleware(makeReq()).headers.get('Content-Security-Policy')!
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it("CSP blocks object embeds via object-src 'none'", () => {
    const csp = middleware(makeReq()).headers.get('Content-Security-Policy')!
    expect(csp).toContain("object-src 'none'")
  })

  it('sets X-Content-Type-Options: nosniff', () => {
    expect(middleware(makeReq()).headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('sets X-Frame-Options: DENY', () => {
    expect(middleware(makeReq()).headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('sets Referrer-Policy', () => {
    expect(middleware(makeReq()).headers.get('Referrer-Policy')).toBeTruthy()
  })

  it('sets Permissions-Policy', () => {
    expect(middleware(makeReq()).headers.get('Permissions-Policy')).toBeTruthy()
  })

  it('applies to API routes', () => {
    const res = middleware(makeReq('/api/run'))
    expect(res.headers.get('Content-Security-Policy')).toBeTruthy()
  })
})
