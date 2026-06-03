'use client'

import { useState, useEffect } from 'react'

const BYO_SESSION_KEY = 'byo_api_key'
const JUDGE_BYO_SESSION_KEY = 'judge_uses_byo'

/**
 * Returns the BYO headers to include on every API fetch.
 * Call this client-side; returns {} when called server-side or when no key is stored.
 */
export function getByoHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  const key = sessionStorage.getItem(BYO_SESSION_KEY)
  if (!key) return {}
  return { 'X-Byo-Api-Key': key }
}

/**
 * Returns whether the user opted in to running the judge with their own key.
 * When true, faithfulness scores are non-comparable to the seeded baseline.
 */
export function getJudgeUsesByo(): boolean {
  if (typeof window === 'undefined') return false
  return sessionStorage.getItem(JUDGE_BYO_SESSION_KEY) === 'true'
}

export function ApiKeyInput() {
  const [apiKey, setApiKey] = useState('')
  const [judgeUsesByo, setJudgeUsesByo] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setApiKey(sessionStorage.getItem(BYO_SESSION_KEY) ?? '')
    setJudgeUsesByo(sessionStorage.getItem(JUDGE_BYO_SESSION_KEY) === 'true')
  }, [])

  function handleSave() {
    if (apiKey.trim()) {
      sessionStorage.setItem(BYO_SESSION_KEY, apiKey.trim())
    } else {
      sessionStorage.removeItem(BYO_SESSION_KEY)
    }
    sessionStorage.setItem(JUDGE_BYO_SESSION_KEY, String(judgeUsesByo))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  function handleClear() {
    sessionStorage.removeItem(BYO_SESSION_KEY)
    sessionStorage.removeItem(JUDGE_BYO_SESSION_KEY)
    setApiKey('')
    setJudgeUsesByo(false)
  }

  const hasKey = Boolean(apiKey.trim())

  return (
    <section style={{ marginTop: '1.5rem', padding: '1rem', border: '1px solid #ccc', borderRadius: '6px', maxWidth: '600px' }}>
      <h2 style={{ margin: '0 0 0.5rem' }}>Bring Your Own Key (optional)</h2>

      <p style={{ fontSize: '0.85rem', color: '#555', margin: '0 0 1rem' }}>
        <strong>Trust model:</strong> Your key is stored in{' '}
        <code>sessionStorage</code> only — cleared when you close this tab, never
        written to <code>localStorage</code> or a cookie. It is sent per-request as
        an HTTPS header (<code>X-Byo-Api-Key</code>), never in the URL or request
        body. The server uses it in-flight only and never logs or persists it.{' '}
        <strong>
          sessionStorage values are readable by any script running on this page;
          the Content-Security-Policy on this site blocks third-party scripts to
          mitigate XSS exfiltration.
        </strong>
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
        <input
          type="password"
          placeholder="sk-ant-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          style={{ flex: 1, padding: '0.4rem 0.6rem', fontFamily: 'monospace', fontSize: '0.9rem' }}
          autoComplete="off"
          spellCheck={false}
        />
        <button onClick={handleSave} style={{ padding: '0.4rem 0.8rem' }}>
          {saved ? 'Saved!' : 'Save'}
        </button>
        {hasKey && (
          <button onClick={handleClear} style={{ padding: '0.4rem 0.8rem', color: '#c00' }}>
            Clear
          </button>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={judgeUsesByo}
          onChange={(e) => setJudgeUsesByo(e.target.checked)}
          disabled={!hasKey}
        />
        Use my key for the judge too
      </label>

      {judgeUsesByo && hasKey && (
        <p style={{ marginTop: '0.5rem', padding: '0.5rem 0.75rem', background: '#fff3cd', border: '1px solid #ffc107', borderRadius: '4px', fontSize: '0.85rem', color: '#664d03' }}>
          <strong>Warning:</strong> Faithfulness scores will use your key, which
          means results are <strong>non-comparable to the seeded baseline</strong>.
          Use this only for experimentation.
        </p>
      )}

      {!hasKey && (
        <p style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: '#888' }}>
          No key stored — requests use the shared free-tier quota (rate-limited).
        </p>
      )}
    </section>
  )
}
