'use client'

import { useEffect, useState } from 'react'
import { parseExampleArtifact, type NotebookExampleArtifact } from './example-artifact'

// ── Worked-example LOADER hook (N13b) ─────────────────────────────────────────
//
// On `?example=1` this fetches the committed artifact from the static route and
// validates it into a typed `NotebookExampleArtifact`. The replay it feeds is
// CLIENT-SIDE and spends ZERO metered calls — the fetch is a static file read, not
// a model call (see /api/notebook/example).
//
// States:
//   • idle        — not requested (no `?example=1`)
//   • loading     — fetch in flight
//   • ready       — artifact fetched + validated; replay can render
//   • unavailable — the maintainer has not committed the artifact yet (404)
//   • error       — fetch failed or the bytes did not validate

export type WorkedExampleStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

export interface UseWorkedExample {
  status: WorkedExampleStatus
  artifact: NotebookExampleArtifact | null
  /** Human-readable detail for the error/unavailable states. */
  message: string | null
}

export function useWorkedExample(active: boolean): UseWorkedExample {
  const [status, setStatus] = useState<WorkedExampleStatus>('idle')
  const [artifact, setArtifact] = useState<NotebookExampleArtifact | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!active) {
      setStatus('idle')
      setArtifact(null)
      setMessage(null)
      return
    }

    let cancelled = false
    setStatus('loading')
    setMessage(null)

    void (async () => {
      try {
        const res = await fetch('/api/notebook/example')
        if (res.status === 404) {
          if (!cancelled) {
            setStatus('unavailable')
            setMessage('The worked example has not been committed yet.')
          }
          return
        }
        if (!res.ok) throw new Error(`Could not load the worked example (HTTP ${res.status}).`)
        const raw: unknown = await res.json()
        const parsed = parseExampleArtifact(raw)
        if (!cancelled) {
          setArtifact(parsed)
          setStatus('ready')
        }
      } catch (e) {
        if (!cancelled) {
          setStatus('error')
          setMessage(e instanceof Error ? e.message : 'Could not load the worked example.')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [active])

  return { status, artifact, message }
}
