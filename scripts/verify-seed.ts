import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

import { checkEmbedderIdentity } from '../src/lib/rag/index.js'

// Minimum fraction of chunks that must carry a non-null section source_xml. The
// parser attaches it to ~100% of chunks; the margin tolerates the rare section
// whose raw substring could not be located rather than asserting perfection.
const SOURCE_XML_MIN_COVERAGE = 0.95

export interface SeedVerification {
  patientCount: number
  chunkCount: number
  recordedPatientCount: number
  recordedChunkCount: number
  sourceXmlCoverage: number
}

async function scalarInt(client: Client, sql: string): Promise<number> {
  const res = await client.query<{ n: string }>(sql)
  return parseInt(res.rows[0].n, 10)
}

async function getMetaInt(client: Client, key: string): Promise<number> {
  const res = await client.query<{ value: string }>(
    'SELECT value FROM seed_meta WHERE key = $1',
    [key]
  )
  if (res.rows.length === 0) {
    throw new Error(
      `seed_meta is missing "${key}" — this seed predates verify-seed's exact-count ` +
        `baseline. Re-run ingest so the single-seed counts are recorded.`
    )
  }
  return parseInt(res.rows[0].value, 10)
}

/**
 * Verifies a freshly-seeded database. Throws (with a descriptive message) on the
 * first failed invariant:
 *   1. EXACT patient count == seed_meta.patient_count
 *   2. EXACT chunk count   == seed_meta.chunk_count   (a duplicate re-seed doubles
 *      the actual chunks while the recorded baseline stays frozen → mismatch)
 *   3. embedder identity (seed_meta.embedder/dimension vs the runtime MODEL/DIM)
 *   4. source_xml non-null coverage >= 95%
 */
export async function verifySeed(client: Client): Promise<SeedVerification> {
  const recordedPatientCount = await getMetaInt(client, 'patient_count')
  const recordedChunkCount = await getMetaInt(client, 'chunk_count')

  const patientCount = await scalarInt(client, 'SELECT count(*)::text AS n FROM patients')
  const chunkCount = await scalarInt(client, 'SELECT count(*)::text AS n FROM chunks')

  if (patientCount !== recordedPatientCount) {
    throw new Error(
      `Patient count mismatch: found ${patientCount}, expected EXACTLY ${recordedPatientCount} ` +
        `(seed_meta.patient_count). A duplicate or partial seed is the usual cause.`
    )
  }

  if (chunkCount !== recordedChunkCount) {
    throw new Error(
      `Chunk count mismatch: found ${chunkCount}, expected EXACTLY ${recordedChunkCount} ` +
        `(seed_meta.chunk_count). ${chunkCount === recordedChunkCount * 2 ? 'This is exactly double — a duplicate re-seed.' : 'A duplicate or partial seed is the usual cause.'}`
    )
  }

  // Reuses the runtime identity guard: asserts seed_meta.embedder == MODEL and
  // seed_meta.dimension == DIM (throws "Embedder mismatch" / "Dimension mismatch").
  await checkEmbedderIdentity(client)

  const withXml = await scalarInt(
    client,
    'SELECT count(*)::text AS n FROM chunks WHERE source_xml IS NOT NULL'
  )
  const sourceXmlCoverage = chunkCount === 0 ? 0 : withXml / chunkCount
  if (sourceXmlCoverage < SOURCE_XML_MIN_COVERAGE) {
    throw new Error(
      `source_xml coverage ${(sourceXmlCoverage * 100).toFixed(1)}% is below the ` +
        `${(SOURCE_XML_MIN_COVERAGE * 100).toFixed(0)}% minimum ` +
        `(${withXml}/${chunkCount} chunks have a non-null source_xml).`
    )
  }

  return {
    patientCount,
    chunkCount,
    recordedPatientCount,
    recordedChunkCount,
    sourceXmlCoverage,
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL env var required')

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    const v = await verifySeed(client)
    console.log('verify-seed OK:')
    console.log(`  patients:           ${v.patientCount} (== seed_meta.patient_count)`)
    console.log(`  chunks:             ${v.chunkCount} (== seed_meta.chunk_count)`)
    console.log(`  source_xml coverage: ${(v.sourceXmlCoverage * 100).toFixed(1)}%`)
    console.log('  embedder identity:  matches runtime MODEL/DIM')
  } finally {
    await client.end()
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(`verify-seed FAILED: ${err.message}`)
    process.exit(1)
  })
}
