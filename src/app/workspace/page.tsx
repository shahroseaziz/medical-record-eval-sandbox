import { permanentRedirect } from 'next/navigation'

// O12b/S26 — /workspace is retired. The bench reached capability parity
// (authoring O5, RAG O10, selective fan-out O6b, round-trip O7a/b, delta O8,
// labels/agreement O9, rubric calibration loop + set export/import ported in
// O12b), so the legacy surface 301s home. Legacy localStorage cases remain
// importable via the bench's migration banner (D5 — non-destructive).
export default function WorkspaceRetired(): never {
  permanentRedirect('/workbench')
}
