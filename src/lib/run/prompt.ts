// Generation prompt assembly — the single source of truth for what text the
// generator model sees. Extracted from /api/run so the firewall test (E25) can
// assert over the SAME assembly the route uses, never a drifting duplicate.
//
// Firewall invariant (E4/E13/E25): the assembled prompt is built ONLY from the
// query, the grounding context (retrieved chunks or the record), and the optional
// caller-supplied generation prompt. Hand-authored expected-output fields
// (expectedProse / expectedStructured) are answer-key data and have no path into
// this function — they are never parameters here.

import type { RetrievedChunk } from '@/lib/rag/index'

export const DEFAULT_SYSTEM_PROMPT =
  'You are a medical record analyst. Answer the question based ONLY on the provided medical record context. Do not use outside knowledge or make assumptions beyond what is stated.'

export function buildGroundingContext(
  mode: 'retrieve' | 'stuff',
  chunks: RetrievedChunk[],
  record?: string,
): string {
  if (mode === 'retrieve') {
    if (chunks.length === 0) return '(no retrieved context available)'
    return chunks.map((c) => `[${c.section}]\n${c.text}`).join('\n\n---\n\n')
  }
  return record ?? '(no record provided)'
}

export interface AssembledPrompt {
  systemPrompt: string
  userTurnPrompt: string
  isUserAuthored: boolean
}

export function buildPrompt(
  query: string,
  groundingContext: string,
  generationPrompt?: string,
): AssembledPrompt {
  return {
    systemPrompt: generationPrompt ?? DEFAULT_SYSTEM_PROMPT,
    userTurnPrompt: `MEDICAL RECORD CONTEXT:\n${groundingContext}\n\nQUESTION:\n${query}\n\nProvide a thorough, accurate answer based solely on the information in the medical record context above. If the context does not contain sufficient information to answer the question, say so explicitly.`,
    isUserAuthored: Boolean(generationPrompt),
  }
}
