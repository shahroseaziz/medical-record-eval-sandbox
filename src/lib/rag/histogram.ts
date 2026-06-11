// Chunk-count distribution — emitted at ingest and replayed by the RAG bench.
//
// Dependency-free (no `pg`/Voyage/fs) so it can be shared by the ingest script,
// the client-bundled bench Inspector, and the unit tests that recompute it from
// the committed C-CDA fixtures. The point of surfacing a DISTRIBUTION rather than
// a "~6–9 chunks" point claim is honesty: the median Synthea patient is small and
// the 6 MB patient is the lone outlier that makes ranking matter — show that, do
// not assert a single number.

export interface ChunkCountBucket {
  /** Inclusive chunk-count range label. */
  range: string
  /** How many patients fall in this bucket. */
  patients: number
}

interface BucketBound {
  range: string
  lo: number
  hi: number
}

// Fixed buckets so the ingest emission, the committed constant, and the test all
// tally identically. The 33+ bucket isolates the Agustin437 outlier (the 6 MB
// gate patient; chunk count snapshot-verified in the C-CDA parse tests).
export const CHUNK_BUCKETS: BucketBound[] = [
  { range: '1–3', lo: 1, hi: 3 },
  { range: '4–6', lo: 4, hi: 6 },
  { range: '7–9', lo: 7, hi: 9 },
  { range: '10–15', lo: 10, hi: 15 },
  { range: '16–32', lo: 16, hi: 32 },
  { range: '33+', lo: 33, hi: Infinity },
]

/** Tally per-patient chunk counts into the fixed buckets. Pure: same input →
 *  same output, so the ingest-emitted histogram and the committed bench constant
 *  can be asserted equal over the same parsed corpus. */
export function chunkCountHistogram(counts: number[]): ChunkCountBucket[] {
  return CHUNK_BUCKETS.map((b) => ({
    range: b.range,
    patients: counts.filter((n) => n >= b.lo && n <= b.hi).length,
  }))
}
