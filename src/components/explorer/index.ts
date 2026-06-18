/**
 * Explore-the-data drawer surface (N7a: sortable all-patients table; N7b:
 * per-patient chart detail + Parsed/Raw-XML toggle). Wired into the notebook at
 * src/app/notebook/NotebookShell.tsx — the Explore button and the output-card
 * "view chart" links both drive <ExplorerDrawer> directly (the N7a ExplorerShell
 * test-harness wrapper was dropped at wire-in: the real shell owns the open state).
 */
export { ExplorerDrawer } from './ExplorerDrawer'
export type { ExplorerDrawerProps } from './ExplorerDrawer'

export { PatientChartDetail } from './PatientChartDetail'
export type { PatientChartDetailProps } from './PatientChartDetail'

export type {
  ExplorerPatient,
  AllPatientsResponse,
  ChunkRow,
  ChunksResponse,
} from './types'
