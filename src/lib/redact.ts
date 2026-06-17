/**
 * The HTTP header the BYO Anthropic key travels on. Single source for the name so
 * clients that SEND it (e.g. the notebook run loop) reference this constant rather
 * than re-typing the literal — which keeps the key-redaction grep's allowlist tight.
 */
export const BYO_KEY_HEADER = 'x-byo-api-key'

/** Header names that MUST NEVER appear in logs or persist to any sink. */
export const SENSITIVE_HEADERS = [BYO_KEY_HEADER] as const

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
