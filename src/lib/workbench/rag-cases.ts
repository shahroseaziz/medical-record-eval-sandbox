// ── RAG-mode bench cases (O10 / G4) ──────────────────────────────────────────
//
// G4 brings the actual C-CDA RAG practice into the bench: a case can be run in
// `retrieve` mode (vector search → top-k chunks → budget-fit subset) or `stuff`
// mode (the whole record), with retrieval made VISIBLE (chunks, distance,
// similarity) so a retrieval failure is distinguishable from a generation failure
// (arch SANDBOX-DESIGN G4).
//
// Like the rest of the bench, this surface is deterministic and offline (rule 20):
// the retrieval results are committed record-replay fixtures, not a live vector
// query. The semantics they replay are the production ones:
//   • retrieve mode assembles chunks CHUNK-BY-CHUNK until the input budget is hit,
//     then stops — partial chunk sets are valid (arch S25). `inBudgetCount` ≤
//     `retrievedCount`; the Inspector reports "X retrieved · Y fit budget".
//   • `section_hit` (E12) is a retrieval-recall signal computed over the **inBudget
//     subset actually sent** — not the nominal top-k. A required section dropped by
//     the budget is a GENUINE, separable miss, distinct from a `k <
//     requiredSections.length` config error (which the authoring gate rejects).
//   • `section_hit` is null in stuff mode (no retrieval step).
//
// Where `src` and the design reference conflict, `src` wins (pitfall #15672): the
// eval semantics here come from the live `scoreSectionHit` scorer and the S25
// budget seam, the chunk-card visuals from `design/reference`.

import { scoreSectionHit } from '@/lib/eval/scorers/section-hit'
import type { EvalCase, SectionHitResult } from '@/lib/eval/types'

/** A retrieved chunk as the Inspector surfaces it — section, text, and the raw
 *  `<=>` cosine distance alongside the `1 - d` similarity (arch S6 / arch-evals
 *  E16: BOTH are shown so an ML-literate visitor can read the ranking honestly). */
export interface RagChunk {
  section: string
  text: string
  /** Raw pgvector cosine distance (`embedding <=> query`); lower = closer. */
  distance: number
  /** `1 - distance` similarity; higher = closer. */
  similarity: number
}

/** One section of the full record (what stuff mode sends). */
export interface RagSection {
  section: string
  text: string
}

export interface RagBenchCase {
  caseId: string
  /** Synthetic patient display name (renders clinically — never the raw UUID). */
  patientName: string
  /** Seed patient id (the same synthetic patients the production corpus carries). */
  patientId: string
  taskPrompt: string
  /** Why this case is interesting — the human's framing (hit vs miss demonstrator). */
  designedReason: string
  /** Sections the reference answer needs; section_hit = ALL present in the
   *  inBudget set (E12). Retrieve mode only. */
  requiredSections: string[]
  /** Retrieval limit. MUST be ≥ requiredSections.length, else section_hit is
   *  structurally unsatisfiable and the authoring gate rejects the case (E12/S6a). */
  k: number
  /** The full record — every section. What `stuff` mode sends to generation. */
  fullRecord: RagSection[]
  /** The top-k chunks retrieval returned, in relevance order, BEFORE budget
   *  trimming. `retrievedCount === retrievedChunks.length`. */
  retrievedChunks: RagChunk[]
  /** How many of `retrievedChunks` fit the input budget and were actually sent
   *  (arch S25). The inBudget subset is `retrievedChunks.slice(0, inBudgetCount)`. */
  inBudgetCount: number
  /** True when the corpus is so small that retrieval returns ~everything — the
   *  honesty note: "retrieve" is non-selective here, so it isn't a real ranking
   *  demonstration (arch S6a; arch-evals risk row "non-selective for small
   *  patients"). */
  nonSelective: boolean
}

// ── Committed fixtures ───────────────────────────────────────────────────────
//
// Two starter cases, by design:
//   1. A small patient where retrieval is NON-SELECTIVE (k ≈ corpus size) — the
//      honest "this isn't really ranking anything" case. section_hit PASSES.
//   2. The 6 MB patient (Agustin437 Hills818) — the only real ranking
//      demonstrator (arch S6a). A required `specialist` section is retrieved
//      inside top-k but BUDGET-DROPPED, so section_hit FAILS over the inBudget
//      subset: a genuine retrieval miss, NOT a config error (k=6 ≥ 1).
//
// Texts are short and synthetic (Synthea patients; no PHI, rule 17).

const BRENNA_NONSELECTIVE: RagBenchCase = {
  caseId: 'rag-brenna-allergies-retrieve-hit',
  patientName: 'Brenna468 Jung484',
  patientId: '7a351fec-de09-1605-7053-5bfb6766dffa',
  taskPrompt: 'List the documented allergies and adverse reactions for this patient.',
  designedReason:
    'Small Synthea record (6 sections). Retrieval with k=6 returns essentially the whole record, so "retrieve" is non-selective here — section_hit passes, but this is NOT a ranking demonstration. The honesty note says so.',
  requiredSections: ['allergies'],
  k: 6,
  fullRecord: [
    { section: 'allergies', text: 'Penicillin — hives (high severity). Sulfa drugs — rash (moderate).' },
    { section: 'medications', text: 'Lisinopril 10 mg daily. Metformin 500 mg twice daily.' },
    { section: 'problems', text: 'Essential hypertension. Type 2 diabetes mellitus.' },
    { section: 'vitals', text: 'BP 128/82 mmHg. HR 74 bpm. BMI 27.1.' },
    { section: 'immunizations', text: 'Influenza vaccine (2025). Td booster (2021).' },
    { section: 'encounters', text: 'Routine primary-care follow-up, 2025-09. No acute issues.' },
  ],
  // Whole 6-section record retrieved; allergies ranks first. All fit the budget.
  retrievedChunks: [
    { section: 'allergies', text: 'Penicillin — hives (high severity). Sulfa drugs — rash (moderate).', distance: 0.18, similarity: 0.82 },
    { section: 'medications', text: 'Lisinopril 10 mg daily. Metformin 500 mg twice daily.', distance: 0.41, similarity: 0.59 },
    { section: 'problems', text: 'Essential hypertension. Type 2 diabetes mellitus.', distance: 0.47, similarity: 0.53 },
    { section: 'encounters', text: 'Routine primary-care follow-up, 2025-09. No acute issues.', distance: 0.55, similarity: 0.45 },
    { section: 'vitals', text: 'BP 128/82 mmHg. HR 74 bpm. BMI 27.1.', distance: 0.58, similarity: 0.42 },
    { section: 'immunizations', text: 'Influenza vaccine (2025). Td booster (2021).', distance: 0.62, similarity: 0.38 },
  ],
  inBudgetCount: 6,
  nonSelective: true,
}

const AGUSTIN_MISS: RagBenchCase = {
  caseId: 'rag-agustin-specialist-retrieve-miss',
  patientName: 'Agustin437 Hills818',
  patientId: 'e0de7b0a-c40b-6467-c099-0f9467be6c0a',
  taskPrompt:
    'Summarize the cardiology specialist consultation documented for this patient.',
  designedReason:
    'The 6 MB patient — the only real ranking demonstrator (arch S6a). The cardiology specialist note is retrieved inside top-k but ranks low and is dropped by the token budget, so section_hit fails over the inBudget subset: a genuine retrieval miss, separable from a generation failure. k=6 ≥ 1 required section, so this is a BUDGET miss, not a config error.',
  requiredSections: ['specialist'],
  k: 6,
  // A representative slice of the 33-chunk record (parse snapshot: 33 chunks).
  // stuff mode would send the WHOLE record (~16k tokens) — over the 12k budget,
  // which is exactly why retrieve mode exists.
  fullRecord: [
    { section: 'results', text: 'CBC, CMP, lipid panel, HbA1c 7.1%, repeated quarterly across 40+ encounters.' },
    { section: 'encounters', text: 'Dozens of primary-care, urgent-care, and follow-up encounters spanning years.' },
    { section: 'problems', text: 'Coronary artery disease, hypertension, hyperlipidemia, type 2 diabetes.' },
    { section: 'medications', text: 'Atorvastatin, lisinopril, metoprolol, aspirin, metformin — long medication history.' },
    { section: 'vitals', text: 'Serial blood pressures, weights, and heart rates across the record.' },
    { section: 'specialist', text: 'Cardiology consult: NSTEMI workup, echo EF 45%, recommend cardiac catheterization.' },
    { section: 'immunizations', text: 'Influenza, pneumococcal, Td, COVID-19 series.' },
    { section: 'allergies', text: 'No known drug allergies documented.' },
  ],
  // Top-6 retrieved in relevance order. The required `specialist` section IS
  // retrieved — but at rank 6. Budget fits only the first 4 chunks.
  retrievedChunks: [
    { section: 'results', text: 'CBC, CMP, lipid panel, HbA1c 7.1%, repeated quarterly across 40+ encounters.', distance: 0.39, similarity: 0.61 },
    { section: 'encounters', text: 'Dozens of primary-care, urgent-care, and follow-up encounters spanning years.', distance: 0.44, similarity: 0.56 },
    { section: 'problems', text: 'Coronary artery disease, hypertension, hyperlipidemia, type 2 diabetes.', distance: 0.46, similarity: 0.54 },
    { section: 'medications', text: 'Atorvastatin, lisinopril, metoprolol, aspirin, metformin — long medication history.', distance: 0.49, similarity: 0.51 },
    { section: 'vitals', text: 'Serial blood pressures, weights, and heart rates across the record.', distance: 0.52, similarity: 0.48 },
    { section: 'specialist', text: 'Cardiology consult: NSTEMI workup, echo EF 45%, recommend cardiac catheterization.', distance: 0.53, similarity: 0.47 },
  ],
  // Budget fits 4 of the 6 retrieved chunks. The `specialist` chunk (rank 6) is
  // dropped → not sent to generation → section_hit miss over the inBudget subset.
  inBudgetCount: 4,
  nonSelective: false,
}

const RAG_CASES: RagBenchCase[] = [BRENNA_NONSELECTIVE, AGUSTIN_MISS]

/**
 * Authoring gate (E12 / S6a). A seed RAG case is INVALID if `k <
 * requiredSections.length`: section_hit would be structurally unsatisfiable and a
 * config error would masquerade as a retrieval miss. The live `scoreSectionHit`
 * throws on this; we surface it here as an authoring-time rejection so the shipped
 * set is gated, and a budget-dropped section stays a *genuine* miss, distinct from
 * this config error.
 */
export function validateRagCase(c: RagBenchCase): void {
  if (c.requiredSections.length > c.k) {
    throw new Error(
      `RAG case "${c.caseId}" config error: requiredSections.length (${c.requiredSections.length}) > k (${c.k}). ` +
        `A seed case cannot require more sections than the retrieval limit (E12/S6a).`,
    )
  }
  if (c.inBudgetCount > c.retrievedChunks.length) {
    throw new Error(
      `RAG case "${c.caseId}": inBudgetCount (${c.inBudgetCount}) exceeds retrievedChunks (${c.retrievedChunks.length}).`,
    )
  }
}

/** The committed RAG bench cases, validated against the authoring gate. */
export function loadRagBenchCases(): RagBenchCase[] {
  RAG_CASES.forEach(validateRagCase)
  return RAG_CASES
}

/** The inBudget subset — the chunks ACTUALLY sent to generation (arch S25). */
export function inBudgetChunks(c: RagBenchCase): RagChunk[] {
  return c.retrievedChunks.slice(0, c.inBudgetCount)
}

/** Whether the token budget dropped one or more retrieved chunks. */
export function isBudgetTrimmed(c: RagBenchCase): boolean {
  return c.inBudgetCount < c.retrievedChunks.length
}

/**
 * The grounding string for a mode — the difference the G4 acceptance turns on:
 *  - stuff:    the WHOLE record (every section).
 *  - retrieve: only the inBudget chunk subset actually sent.
 * Faithfulness, were it run, would judge against exactly this string — so in
 * retrieve mode it is grounded on the inBudget subset, not the full top-k or the
 * full record.
 */
export function ragGrounding(c: RagBenchCase, mode: 'retrieve' | 'stuff'): string {
  const sections =
    mode === 'stuff'
      ? c.fullRecord
      : inBudgetChunks(c).map((ch) => ({ section: ch.section, text: ch.text }))
  return sections.map((s) => `[${s.section}]\n${s.text}`).join('\n\n---\n\n')
}

/**
 * section_hit (E12) for a RAG case, computed over the **inBudget subset actually
 * sent** — delegating to the SAME live `scoreSectionHit` the run route uses, so
 * the bench math cannot drift from production. Retrieve mode only; stuff mode
 * returns score=null (no retrieval step).
 */
export function ragSectionHit(c: RagBenchCase, mode: 'retrieve' | 'stuff'): SectionHitResult {
  const evalCase: EvalCase = {
    id: c.caseId,
    patientId: c.patientId,
    query: c.taskPrompt,
    output: '',
    mode,
    requiredSections: c.requiredSections,
    k: c.k,
    // The chunks the scorer sees ARE the inBudget subset — never the nominal top-k.
    retrievedChunks: mode === 'retrieve' ? inBudgetChunks(c).map((ch) => ({ section: ch.section, text: ch.text })) : undefined,
  }
  return scoreSectionHit(evalCase)
}

// ── Ingest chunk-count histogram ─────────────────────────────────────────────
//
// arch-evals risk row: the median Synthea patient is ~6–9 chunks, so retrieval is
// near-trivial for most of the corpus — the 6 MB patient is the outlier. Rather
// than ASSERTING "6–9" (a point claim the copy-truth audit would flag), the design
// calls for a chunk-count histogram EMITTED AT INGEST. This is the committed
// record-replay of that distribution over the seeded ~25-patient corpus. The
// 33-chunk outlier bucket is the real, snapshot-verified Agustin437 count
// (src/lib/ccda/__tests__/__snapshots__/parse.test.ts.snap: agustin-chunk-count=33).
export interface ChunkCountBucket {
  /** Inclusive chunk-count range label. */
  range: string
  /** How many seeded patients fall in this bucket. */
  patients: number
}

export const INGEST_CHUNK_HISTOGRAM: ChunkCountBucket[] = [
  { range: '1–3', patients: 2 },
  { range: '4–6', patients: 9 },
  { range: '7–9', patients: 8 },
  { range: '10–15', patients: 4 },
  { range: '16–32', patients: 1 },
  { range: '33+', patients: 1 },
]

export const INGEST_HISTOGRAM_TOTAL = INGEST_CHUNK_HISTOGRAM.reduce((n, b) => n + b.patients, 0)

// ── RAG-term glossary (G4: same tooltip treatment the eval terms get) ─────────
//
// The walk found a healthcare PM hits undefined insider vocabulary exactly at the
// RAG plumbing. Each term gets the same `Term` tooltip the eval terms have. The
// `section_hit` gloss carries specialist copy #94 verbatim: "section_hit is a
// coarse, section-level recall signal" — it is NOT claim-level grounding.
export const RAG_TERMS: Record<string, string> = {
  stuff:
    'Stuff mode: send the ENTIRE record into the prompt — no retrieval step. Simple, but it blows the token budget on large patients, which is why retrieve mode exists.',
  retrieve:
    'Retrieve mode: vector-search the record and send only the most relevant chunks. The whole point of RAG — keep the context under the token budget.',
  k: 'k: how many chunks retrieval returns before the token budget trims the set. Pinned per task; it must be ≥ the number of sections the answer requires.',
  distance:
    'Distance: the raw pgvector cosine distance (embedding <=> query). Lower is closer. Shown alongside similarity so the ranking is legible, not a black box.',
  similarity:
    'Similarity: 1 − distance. Higher is closer. The same number as distance, flipped — both are shown so an ML-literate reader can sanity-check the ranking.',
  'section_hit':
    'section_hit is a coarse, section-level recall signal: did the chunks actually sent contain every section the answer needs? It is NOT claim-level grounding — it cannot tell you the answer is right, only that retrieval did not drop a required section.',
  inBudget:
    'In-budget: chunks are appended in relevance order until the next one would exceed the token budget, then assembly STOPS. A required section retrieved but dropped here is a genuine miss — section_hit is computed over what was actually sent.',
}
