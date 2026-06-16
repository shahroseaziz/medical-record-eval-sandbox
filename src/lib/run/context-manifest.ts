// ── Context manifest — the "what the model saw" receipt ──────────────────────
//
// A single, generation-mode-agnostic description of the grounding the model was
// given, emitted as a pre-generation stream frame in BOTH retrieve and stuff
// modes. It is a RECEIPT (section names + sizes), not the grounding text itself:
// the notebook surfaces it so a reader can see which sections reached the model
// and which were dropped for budget, without re-shipping (or persisting) the raw
// record text.
//
// Pure + dependency-free so the route, tests, and any future UI build the exact
// same shape from the same inputs.

export interface ContextSection {
  /** Section name as it appears in the grounding (chunk section, or 'record'). */
  section: string
  /** Character length of that section's text as sent to the model. */
  chars: number
}

export interface ContextManifest {
  /** 'retrieved' = retrieve mode (RAG chunks); 'full' = stuff mode (whole record). */
  contextMode: 'retrieved' | 'full'
  /** One entry per section the model actually saw, in send order. */
  sections: ContextSection[]
  /**
   * Retrieve mode only: sections that retrieval returned but the token budget
   * dropped before assembly (SHA-75). Omitted when nothing was dropped.
   */
  droppedSections?: string[]
}

export interface ContextManifestInput {
  mode: 'retrieve' | 'stuff'
  /** In-budget chunks actually sent (retrieve mode). */
  chunks: Array<{ section: string; text: string }>
  /** Sections retrieved but dropped for budget (retrieve mode). */
  droppedSections?: string[]
  /** The full record text (stuff mode). */
  record?: string
}

/**
 * Build the context manifest for a run. Retrieve mode reports one section per
 * in-budget chunk plus any dropped sections; stuff mode reports the whole record
 * as a single 'record' section.
 */
export function buildContextManifest(input: ContextManifestInput): ContextManifest {
  if (input.mode === 'retrieve') {
    const sections = input.chunks.map((c) => ({ section: c.section, chars: c.text.length }))
    // Dedup dropped section names while preserving first-seen order.
    const dropped = Array.from(new Set(input.droppedSections ?? []))
    return {
      contextMode: 'retrieved',
      sections,
      ...(dropped.length > 0 ? { droppedSections: dropped } : {}),
    }
  }
  // stuff mode: the whole record is the single context section.
  const record = input.record ?? ''
  return {
    contextMode: 'full',
    sections: [{ section: 'record', chars: record.length }],
  }
}
