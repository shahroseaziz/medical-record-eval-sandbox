import { withClient } from '@/lib/db/index'
import { NotebookShell } from './NotebookShell'

// The notebook shell needs a live model identity and BYO-key state, so it is a
// client surface; this server wrapper resolves the corpus size for the data
// strip's realism line. A DB-less environment (local dev without a seed, CI)
// must still render the shell — so a failed/absent count degrades to null and
// the realism line drops the number rather than the page erroring.
export const dynamic = 'force-dynamic'

async function loadPatientCount(): Promise<number | null> {
  try {
    return await withClient(async (client) => {
      const result = await client.query('SELECT COUNT(*)::int AS n FROM patients')
      const n = (result.rows[0] as { n?: number } | undefined)?.n
      return typeof n === 'number' ? n : null
    })
  } catch {
    return null
  }
}

export default async function NotebookPage() {
  const patientCount = await loadPatientCount()
  return <NotebookShell patientCount={patientCount} />
}
