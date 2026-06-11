// ── RAG-mode bench cases (O10 / G4) ──────────────────────────────────────────
//
// G4 brings the actual C-CDA RAG practice into the bench: a case can be run in
// `retrieve` mode (vector search → top-k chunks → budget-fit subset) or `stuff`
// mode (the whole record), with retrieval made VISIBLE (chunks, distance,
// similarity) so a retrieval failure is distinguishable from a generation failure
// (arch SANDBOX-DESIGN G4).
//
// Like the rest of the bench, this surface is deterministic and offline (rule 20).
// Be precise about what is AUTHORED vs COMPUTED here, because the honesty of the
// "genuine miss" claim turns on it:
//
//   • AUTHORED (fixture data, written by a human): which chunks retrieval returns,
//     their section + text, and their distance/similarity. There is no committed
//     embedding recording — Voyage/pgvector are not reachable offline — so the
//     distances are ILLUSTRATIVE ranking values, not recorded query outputs. They
//     order the chunks; they are not presented as measured numbers.
//   • COMPUTED (by the real production code, over those authored chunks):
//       – the inBudget subset is produced by the production `fitChunksToBudget`
//         seam (arch S25), driven by the production grounding renderer
//         `buildGroundingContext` and the production token estimator. `inBudgetCount`
//         is NOT a stored literal — `loadRagBenchCases()` runs the seam at load, so
//         the bench trim point cannot silently drift from the run route's. A
//         budget-dropped required section is therefore a trim the MATH produced,
//         not one a fixture asserted.
//       – `section_hit` (E12) is delegated to the live `scoreSectionHit`, computed
//         over the **inBudget subset actually sent** — not the nominal top-k. It is
//         null in stuff mode (no retrieval step).
//
// A required section dropped by the budget is a GENUINE, separable miss, distinct
// from a `k < requiredSections.length` config error (which the authoring gate
// rejects). Where `src` and the design reference conflict, `src` wins (pitfall
// #15672): the eval semantics come from the live scorer and the S25 seam, the
// chunk-card visuals from `design/reference`.

import { scoreSectionHit } from '@/lib/eval/scorers/section-hit'
import type { EvalCase, SectionHitResult } from '@/lib/eval/types'
import { fitChunksToBudget, type RetrievedChunk } from '@/lib/rag/budget'
import { buildGroundingContext } from '@/lib/run/prompt'
import { MAX_INPUT_TOKENS } from '@/lib/tokens'
import type { ChunkCountBucket } from '@/lib/rag/histogram'

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

/** The AUTHORED inputs of a RAG bench case. The budget trim point is deliberately
 *  NOT here — it is computed from these fields by `fitChunksToBudget` at load. */
export interface RagBenchCaseSpec {
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
  /** Input-token budget for retrieve-mode assembly (arch S25). The inBudget subset
   *  is whatever `fitChunksToBudget` keeps under this budget — never a hand-picked
   *  count. Scaled to the short synthetic chunk summaries below so the SAME
   *  production trimming MATH yields an offline-reproducible trim (see AGUSTIN_MISS). */
  budgetTokens: number
  /** Fixed non-chunk prompt cost (system prompt + query scaffolding) charged against
   *  the budget before any chunk — the same overhead the run route subtracts. */
  overheadTokens: number
  /** True when the corpus is so small that retrieval returns ~everything — the
   *  honesty note: "retrieve" is non-selective here, so it isn't a real ranking
   *  demonstration (arch S6a; arch-evals risk row "non-selective for small
   *  patients"). */
  nonSelective: boolean
}

/** A LOADED case: the authored spec plus the budget assembly COMPUTED by the
 *  production `fitChunksToBudget` seam. `inBudgetCount`/`retrievedCount` come from
 *  the seam, never from fixture authorship. */
export interface RagBenchCase extends RagBenchCaseSpec {
  /** `fitChunksToBudget(...).inBudgetCount` — chunks that fit the budget and were
   *  actually sent. The inBudget subset is `retrievedChunks.slice(0, inBudgetCount)`. */
  inBudgetCount: number
  /** `retrievedChunks.length` (before trimming), echoed from the seam. */
  retrievedCount: number
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

const BRENNA_NONSELECTIVE: RagBenchCaseSpec = {
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
  // The real free-tier budget; a 6-section patient fits it whole, so nothing is
  // trimmed — fitChunksToBudget returns all 6 → inBudgetCount === retrievedCount.
  budgetTokens: MAX_INPUT_TOKENS,
  overheadTokens: 100,
  nonSelective: true,
}

const AGUSTIN_MISS: RagBenchCaseSpec = {
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
  // retrieved — but at rank 6, behind five higher-ranked chunks. Whether it
  // survives the budget is decided by fitChunksToBudget below, not asserted here.
  retrievedChunks: [
    { section: 'results', text: 'CBC, CMP, lipid panel, HbA1c 7.1%, repeated quarterly across 40+ encounters.', distance: 0.39, similarity: 0.61 },
    { section: 'encounters', text: 'Dozens of primary-care, urgent-care, and follow-up encounters spanning years.', distance: 0.44, similarity: 0.56 },
    { section: 'problems', text: 'Coronary artery disease, hypertension, hyperlipidemia, type 2 diabetes.', distance: 0.46, similarity: 0.54 },
    { section: 'medications', text: 'Atorvastatin, lisinopril, metoprolol, aspirin, metformin — long medication history.', distance: 0.49, similarity: 0.51 },
    { section: 'vitals', text: 'Serial blood pressures, weights, and heart rates across the record.', distance: 0.52, similarity: 0.48 },
    { section: 'specialist', text: 'Cardiology consult: NSTEMI workup, echo EF 45%, recommend cardiac catheterization.', distance: 0.53, similarity: 0.47 },
  ],
  // Budget/overhead SCALED to these short synthetic chunk summaries: the cumulative
  // grounding cost (production renderer) crosses budgetTokens between chunk 4
  // (~152 + 100 overhead = 252 ≤ 260) and chunk 5 (~184 + 100 = 284 > 260), so
  // fitChunksToBudget keeps exactly the first 4 and DROPS the rank-6 `specialist`
  // chunk. The trim point is the seam's arithmetic, not a literal — change a chunk's
  // text and the kept count recomputes. (The full 33-chunk record really is ~16k
  // tokens over the 12k budget; we scale because the fixture chunks are summaries.)
  budgetTokens: 260,
  overheadTokens: 100,
  nonSelective: false,
}

const RAG_SPECS: RagBenchCaseSpec[] = [BRENNA_NONSELECTIVE, AGUSTIN_MISS]

/**
 * Authoring gate (E12 / S6a). A seed RAG case is INVALID if `k <
 * requiredSections.length`: section_hit would be structurally unsatisfiable and a
 * config error would masquerade as a retrieval miss. The live `scoreSectionHit`
 * throws on this; we surface it here as an authoring-time rejection so the shipped
 * set is gated, and a budget-dropped section stays a *genuine* miss, distinct from
 * this config error.
 */
export function validateRagCase(c: RagBenchCaseSpec): void {
  if (c.requiredSections.length > c.k) {
    throw new Error(
      `RAG case "${c.caseId}" config error: requiredSections.length (${c.requiredSections.length}) > k (${c.k}). ` +
        `A seed case cannot require more sections than the retrieval limit (E12/S6a).`,
    )
  }
  if (c.overheadTokens < 0 || c.budgetTokens <= c.overheadTokens) {
    throw new Error(
      `RAG case "${c.caseId}": budgetTokens (${c.budgetTokens}) must exceed overheadTokens (${c.overheadTokens}).`,
    )
  }
}

/** The production grounding renderer — the SAME function the run route passes to
 *  `fitChunksToBudget`, so the bench measures the budget against the real joined
 *  payload (separators included), not a divergent format. */
const renderGrounding = (chunks: RetrievedChunk[]): string => buildGroundingContext('retrieve', chunks)

/** Resolve an authored spec into a loaded case by running the production budget
 *  seam over its chunks. `inBudgetCount` is the seam's output — never authored. */
function resolveRagCase(spec: RagBenchCaseSpec): RagBenchCase {
  validateRagCase(spec)
  const assembly = fitChunksToBudget(
    spec.retrievedChunks,
    spec.budgetTokens,
    spec.overheadTokens,
    renderGrounding,
  )
  return { ...spec, inBudgetCount: assembly.inBudgetCount, retrievedCount: assembly.retrievedCount }
}

/** The committed RAG bench cases, each validated and budget-resolved via the seam. */
export function loadRagBenchCases(): RagBenchCase[] {
  return RAG_SPECS.map(resolveRagCase)
}

/** The inBudget subset — the chunks ACTUALLY sent to generation (arch S25).
 *  `fitChunksToBudget` keeps a relevance-ordered prefix, so this slice is exactly
 *  the seam's `assembly.chunks`. */
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
  const sections = mode === 'stuff' ? c.fullRecord : inBudgetChunks(c)
  // Route everything through the production grounding renderer so the bench's
  // grounding string is byte-identical to what generation would actually receive.
  const chunks: RetrievedChunk[] = sections.map((s) => ({
    section: s.section,
    text: s.text,
    distance: 0,
    similarity: 0,
  }))
  return renderGrounding(chunks)
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
// arch-evals risk row: the median Synthea patient is small (single-digit chunks),
// so retrieval is near-trivial for most of the corpus — the 6 MB patient is the
// outlier. Rather than ASSERTING "~6–9" (a point claim the copy-truth audit would
// flag), the design surfaces the DISTRIBUTION as a histogram.
//
// These buckets are MEASURED, not invented: they are `chunkCountHistogram(...)`
// over the chunk counts of the committed C-CDA fixtures, computed by the same
// parser ingest runs. The unit test reparses those fixtures and asserts this
// constant equals the recomputed histogram, so it cannot drift. Counts (parse
// snapshot–verified): Agustin437 = 33 (the 6 MB outlier; parse.test.ts.snap
// agustin-chunk-count=33), Brenna468 = 8, Marisela850 = 7. A full ingest emits the
// same histogram over the whole seeded corpus to seed/chunk-histogram.json — this
// constant is the offline-reproducible fixture slice of that emission.
export type { ChunkCountBucket }

/** Number of committed C-CDA fixtures the histogram is measured over. */
export const INGEST_HISTOGRAM_TOTAL = 3

export const INGEST_CHUNK_HISTOGRAM: ChunkCountBucket[] = [
  { range: '1–3', patients: 0 },
  { range: '4–6', patients: 0 },
  { range: '7–9', patients: 2 },
  { range: '10–15', patients: 0 },
  { range: '16–32', patients: 0 },
  { range: '33+', patients: 1 },
]

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
