'use client'

import { useState, useCallback } from 'react'
import type { RunRequest, RunTrace } from '@/app/api/run/types'
import type { FaithfulnessResult, SectionHitResult } from '@/lib/eval/types'
import { getByoHeaders, getJudgeUsesByo } from '@/components/ApiKeyInput'

export interface RetrievalData {
  chunks: Array<{ section: string; text: string; distance: number; similarity: number }>
  groundingContext: string
}

export interface EvalData {
  faithfulness: FaithfulnessResult
  sectionHit: SectionHitResult
}

export interface RunState {
  text: string
  retrieval: RetrievalData | null
  evalResult: EvalData | null
  trace: RunTrace | null
  loading: boolean
  error: string | null
}

// Parses one line of the AI SDK data stream protocol.
// Prefix 0: → text token (JSON string)
// Prefix 2: → data array (JSON array of data items)
// Prefix 3: → error (JSON string)
// Prefix d: → finish metadata (ignored, not end-of-stream signal)
function parseLine(
  line: string,
): { kind: 'text'; value: string } | { kind: 'data'; items: unknown[] } | { kind: 'err'; message: string } | null {
  if (!line.trim()) return null
  const colonIdx = line.indexOf(':')
  if (colonIdx < 0) return null
  const prefix = line.slice(0, colonIdx)
  const rest = line.slice(colonIdx + 1)
  try {
    if (prefix === '0') return { kind: 'text', value: JSON.parse(rest) as string }
    if (prefix === '2') return { kind: 'data', items: JSON.parse(rest) as unknown[] }
    if (prefix === '3') return { kind: 'err', message: JSON.parse(rest) as string }
  } catch {
    // ignore malformed lines
  }
  return null
}

export function useRun() {
  const [state, setState] = useState<RunState>({
    text: '',
    retrieval: null,
    evalResult: null,
    trace: null,
    loading: false,
    error: null,
  })

  const run = useCallback(async (request: RunRequest) => {
    setState({ text: '', retrieval: null, evalResult: null, trace: null, loading: true, error: null })

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getByoHeaders(),
      }
      const body: RunRequest = { ...request, judgeUsesByo: getJudgeUsesByo() }

      const res = await fetch('/api/run', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const payload = (await res.json()) as { error?: string }
        setState((s) => ({ ...s, loading: false, error: payload.error ?? 'Request failed' }))
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        setState((s) => ({ ...s, loading: false, error: 'No response body' }))
        return
      }

      const decoder = new TextDecoder()
      let partial = ''

      const processLine = (line: string) => {
        const parsed = parseLine(line)
        if (!parsed) return
        if (parsed.kind === 'text') {
          setState((s) => ({ ...s, text: s.text + parsed.value }))
        } else if (parsed.kind === 'err') {
          setState((s) => ({ ...s, error: parsed.message }))
        } else if (parsed.kind === 'data') {
          for (const item of parsed.items) {
            const d = item as Record<string, unknown>
            if (d.type === 'retrieval') {
              setState((s) => ({
                ...s,
                retrieval: {
                  chunks: (d.chunks ?? []) as RetrievalData['chunks'],
                  groundingContext: (d.groundingContext ?? '') as string,
                },
              }))
            } else if (d.type === 'eval') {
              setState((s) => ({
                ...s,
                evalResult: {
                  faithfulness: d.faithfulness as FaithfulnessResult,
                  sectionHit: d.sectionHit as SectionHitResult,
                },
              }))
            } else if (d.type === 'trace') {
              setState((s) => ({ ...s, trace: d.trace as RunTrace }))
            } else if (d.type === 'error') {
              setState((s) => ({ ...s, error: (d.message ?? 'Unknown error') as string }))
            }
          }
        }
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        const lines = (partial + chunk).split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) processLine(line)
      }
      if (partial) processLine(partial)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Network error'
      setState((s) => ({ ...s, error: msg }))
    } finally {
      setState((s) => ({ ...s, loading: false }))
    }
  }, [])

  return { ...state, run }
}
