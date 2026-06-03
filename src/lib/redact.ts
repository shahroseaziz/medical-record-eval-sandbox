/** Header names that MUST NEVER appear in logs or persist to any sink. */
export const SENSITIVE_HEADERS = ['x-byo-api-key'] as const

export function redactHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...headers }
  for (const h of SENSITIVE_HEADERS) {
    if (out[h] !== undefined) out[h] = '[REDACTED]'
  }
  return out
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '[REDACTED]'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}
