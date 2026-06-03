# CCDA test fixtures (synthetic Synthea — NO PHI)

Three synthetic patients copied from the Synthea CCDA sample set, committed for unit tests. The full 111-record corpus lives off-repo (fetched by scripts/ingest.ts at seed time).

- `Agustin437_*` (~6.1 MB) — the large-record RAG demonstrator; verifies the parser handles the biggest patient.
- `Marisela850_*`, `Brenna468_*` (~580 KB each) — mid-size records.

Collectively these cover all 8 target sections: problems (11450-4), medications (10160-0), allergies (48765-2), results (30954-2), encounters (46240-8), immunizations (11369-6), vitals (8716-3), plus demographics (recordTarget).
