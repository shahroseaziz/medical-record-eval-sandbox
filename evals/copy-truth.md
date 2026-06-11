# Copy-truth checklist (S27 / G7)

Every capability claim in the app copy maps to the test or behavior that makes it
true. This is a verification artifact, not a vibe: a row is only allowed to ship if
the cited proof exists and passes.

This file is **created-or-extended** by O10 (RAG mode, G4) and audited/extended by
O12a (the full copy-truth audit, S27). O10 owns truthing its OWN RAG-mode copy in
its own accept — it does not wait on O12a, and O12a never authors RAG copy. If O10
is cut as the gated tail, the RAG-mode section below simply does not exist and
O12a has nothing to audit here.

Columns: **Claim** (the copy as shown) · **Where** (surface) · **Proof** (the
test/behavior that makes it true).

## RAG mode (O10 / G4)

| Claim (app copy) | Where | Proof |
| --- | --- | --- |
| "Run the same case in retrieve or stuff mode and watch the grounding change." | bench cases atom → RAG mode (`RagInspector`) | `e2e/ragmode.test.ts` → "the same case shows a grounding difference between retrieve and stuff" — captures the grounding string in each mode and asserts they differ (stuff is the full record, retrieve only the inBudget subset). Unit: `src/lib/workbench/__tests__/rag-cases.test.ts` → "retrieve and stuff grounding differ for the same case". |
| "section_hit is a coarse, section-level recall signal" (specialist copy #94) — it is NOT claim-level grounding. | RAG-term tooltip on `section_hit` | `RAG_TERMS['section_hit']` carries the line verbatim; unit test "section_hit gloss carries specialist copy #94 verbatim"; e2e "RAG-term tooltips include the specialist section_hit copy (#94)" reveals the tooltip and asserts the text. |
| RAG plumbing terms ("stuff", "retrieve", "k", "distance", "similarity", "in-budget") get the same tooltip treatment the eval terms have. | RAG inspector — `Term` glosses throughout | e2e "RAG-term tooltips…" asserts each `term-*` is present; unit "defines the RAG plumbing terms". |
| "✗ missing specialist" — section_hit fires false on the miss case. | RAG inspector section_hit chip | e2e "the miss case demonstrably fires section_hit=false over the inBudget subset"; unit "miss case: required section retrieved in top-k but budget-dropped → section_hit=false". The miss is computed over the **inBudget subset actually sent** (`ragSectionHit` → live `scoreSectionHit`), distinct from a `k < requiredSections` config error which the authoring gate rejects (`validateRagCase`). |
| "X retrieved · Y fit budget" — partial chunk sets are real, not cosmetic. | RAG inspector chunk summary | e2e asserts "6" retrieved and "4 fit budget"; the budget-dropped chunk is rendered `data-dropped="true"` (chunk 5). `inBudgetCount` is COMPUTED, not authored: `loadRagBenchCases()` runs the production `fitChunksToBudget` seam (arch S25) with the production grounding renderer `buildGroundingContext` over the fixture chunks; unit "fitChunksToBudget over the miss fixture reproduces the trim and drops specialist" re-runs the seam and asserts the trim point, so bench and run-route trimming cannot drift. |
| "retrieve is non-selective here" — honest about small patients. | RAG inspector honesty note (small-patient case) | e2e "the small-patient case carries the non-selective honesty note and still hits"; unit "the small-patient case is flagged non-selective and still hits". The note only renders when `nonSelective` is true (corpus ≈ k). |
| section_hit is "N/A" in stuff mode (no retrieval step). | RAG inspector stuff-mode note | e2e "stuff mode reports section_hit as N/A (no retrieval step)"; unit "stuff mode has no retrieval step → section_hit is null". |
| "Chunks per patient at ingest" — measured distribution, not an asserted "6–9". | RAG inspector histogram | `INGEST_CHUNK_HISTOGRAM` is MEASURED, not authored: it is `chunkCountHistogram(...)` over the chunk counts of the committed C-CDA fixtures (Agustin437=33, Brenna468=8, Marisela850=7), and unit "the committed constant equals the histogram recomputed from the fixtures" reparses those fixtures and asserts equality, so no bucket is an invented number. The 33+ outlier is the snapshot-verified Agustin437 count (`src/lib/ccda/__tests__/__snapshots__/parse.test.ts.snap`: `agustin-chunk-count=33`). A full `scripts/ingest.ts` run emits the same histogram over the whole corpus to `seed/chunk-histogram.json`. e2e "the ingest chunk-count histogram is shown". |
| Both raw distance and `1 − d` similarity are shown per chunk. | RAG inspector chunk cards | e2e asserts `rag-chunk-0-distance` shows "dist" and `rag-chunk-0-similarity` shows "sim" (arch S6 / arch-evals E16). |
