import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { execSync } from 'node:child_process'
import { createGzip } from 'node:zlib'

import { parseCcda } from '../src/lib/ccda/index.js'
import { SCHEMA_SQL, withClient } from '../src/lib/db/index.js'
import { embed } from '../src/lib/voyage.js'
import { chunkCountHistogram } from '../src/lib/rag/histogram.js'

const DRY_RUN = process.argv.includes('--dry-run')
const LOCAL_IDX = process.argv.indexOf('--local')
const LOCAL_DIR = LOCAL_IDX !== -1 ? process.argv[LOCAL_IDX + 1] : null
const BATCH_SIZE = 16

// Absolute path is always relative to project root (CWD when tsx is invoked)
const FIXTURE_DIR = join(process.cwd(), 'src/lib/ccda/__fixtures__')

function escapeCopyText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
}

interface PatientRow {
  id: string
  name: string
  summary: unknown
}

interface ChunkRow {
  patientId: string
  section: string
  ord: number
  text: string
  embedding: number[]
}

async function processXml(
  xml: string
): Promise<{ patient: PatientRow; chunks: ChunkRow[] }> {
  const { patientId, demographics, chunks: rawChunks, summary } = parseCcda(xml)

  const name = [demographics.firstName, demographics.lastName].filter(Boolean).join(' ')

  const texts = rawChunks.map((c) => c.text)
  const embeddings: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const batchVecs = await embed(batch, 'document')
    embeddings.push(...batchVecs)
  }

  const chunkRows: ChunkRow[] = rawChunks.map((c, i) => ({
    patientId,
    section: c.section,
    ord: c.ord,
    text: c.text,
    embedding: embeddings[i],
  }))

  return {
    patient: { id: patientId, name, summary },
    chunks: chunkRows,
  }
}

async function getXmlFiles(): Promise<string[]> {
  if (LOCAL_DIR) {
    const absDir = join(process.cwd(), LOCAL_DIR)
    console.log(`--local: reading XML files from ${absDir}`)
    return readdirSync(absDir)
      .filter((f) => f.endsWith('.xml'))
      .map((f) => join(absDir, f))
  }

  if (DRY_RUN) {
    console.log('--dry-run: using fixtures')
    return readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith('.xml'))
      .slice(0, 3)
      .map((f) => join(FIXTURE_DIR, f))
  }

  const corpusUrl = process.env.CORPUS_URL
  if (!corpusUrl) throw new Error('CORPUS_URL env var required')

  console.log(`Fetching corpus from ${corpusUrl} ...`)
  const resp = await fetch(corpusUrl)
  if (!resp.ok) throw new Error(`Failed to fetch corpus: ${resp.status}`)

  const tmpBase = join(tmpdir(), `ingest-${Date.now()}`)
  mkdirSync(tmpBase, { recursive: true })
  const archivePath = join(tmpBase, 'corpus.tar.gz')

  const writer = createWriteStream(archivePath)
  const body = resp.body
  if (!body) throw new Error('Empty response body from corpus URL')
  await new Promise<void>((resolve, reject) => {
    const reader = body.getReader()
    const pump = (): void => {
      reader.read().then(({ done, value }) => {
        if (done) { writer.end(); return }
        writer.write(value, pump)
      }).catch(reject)
    }
    writer.on('finish', resolve)
    writer.on('error', reject)
    pump()
  })

  const extractDir = join(tmpBase, 'xml')
  mkdirSync(extractDir, { recursive: true })
  execSync(`tar xz -C "${extractDir}" -f "${archivePath}"`)

  function findXml(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name)
      if (e.isDirectory()) return findXml(full)
      return e.name.endsWith('.xml') ? [full] : []
    })
  }

  const files = findXml(extractDir)
  console.log(`Found ${files.length} XML files`)
  return files
}

async function main(): Promise<void> {
  const xmlFiles = await getXmlFiles()

  const patientRows: PatientRow[] = []
  const chunkRows: ChunkRow[] = []

  for (const xmlFile of xmlFiles) {
    console.log(`Processing ${basename(xmlFile)} ...`)
    const xml = readFileSync(xmlFile, 'utf-8')
    const { patient, chunks } = await processXml(xml)
    patientRows.push(patient)
    chunkRows.push(...chunks)
    console.log(`  → patient ${patient.id}, ${chunks.length} chunks`)
  }

  // Emit the chunk-count distribution over the corpus actually ingested. This is
  // the source the RAG bench replays — surfaced as a histogram (not a "~6–9"
  // point claim) so the small-patient majority and the lone outlier are both
  // visible and measured, never asserted.
  const perPatientCounts = patientRows.map(
    (p) => chunkRows.filter((c) => c.patientId === p.id).length,
  )
  const histogram = chunkCountHistogram(perPatientCounts)
  console.log('\nChunk-count histogram (per patient):')
  for (const b of histogram) {
    console.log(`  ${b.range.padEnd(7)} ${b.patients}`)
  }

  if (DRY_RUN) {
    console.log(`\nDry run complete: ${patientRows.length} patients, ${chunkRows.length} total chunks`)
    if (patientRows[0]) {
      console.log('Sample summary:', JSON.stringify(patientRows[0].summary, null, 2))
    }
    return
  }

  // Write to database
  console.log(`Writing ${patientRows.length} patients, ${chunkRows.length} chunks to database...`)
  await withClient(async (client) => {
    await client.query(SCHEMA_SQL)

    for (const p of patientRows) {
      await client.query(
        `INSERT INTO patients (id, name, summary) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, summary = EXCLUDED.summary`,
        [p.id, p.name, JSON.stringify(p.summary)]
      )
    }

    for (const c of chunkRows) {
      const vec = `[${c.embedding.join(',')}]`
      await client.query(
        `INSERT INTO chunks (patient_id, section, ord, text, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [c.patientId, c.section, c.ord, c.text, vec]
      )
    }

    await client.query(`
      INSERT INTO seed_meta (key, value) VALUES
        ('embedder',    'voyage-3.5'),
        ('dimension',   '1024'),
        ('input_type',  'document')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `)
  })

  if (LOCAL_DIR) {
    console.log('Local mode: skipping seed dump generation.')
    return
  }

  // Generate seed/embeddings.sql.gz
  console.log('Generating seed dump...')
  mkdirSync('seed', { recursive: true })

  // Persist the measured distribution next to the seed so the bench's committed
  // histogram can be diffed against a real ingest (provenance, not invention).
  writeFileSync(
    'seed/chunk-histogram.json',
    JSON.stringify({ patients: patientRows.length, buckets: histogram }, null, 2) + '\n',
  )
  console.log('Chunk-count histogram written to seed/chunk-histogram.json')

  const lines: string[] = []

  lines.push(SCHEMA_SQL)
  lines.push('')

  lines.push('COPY patients (id, name, summary) FROM STDIN;')
  for (const p of patientRows) {
    lines.push(
      `${escapeCopyText(p.id)}\t${escapeCopyText(p.name)}\t${escapeCopyText(JSON.stringify(p.summary))}`
    )
  }
  lines.push('\\.')
  lines.push('')

  lines.push('COPY chunks (patient_id, section, ord, text, embedding) FROM STDIN;')
  for (const c of chunkRows) {
    const vec = `[${c.embedding.join(',')}]`
    lines.push(
      `${escapeCopyText(c.patientId)}\t${escapeCopyText(c.section)}\t${c.ord}\t${escapeCopyText(c.text)}\t${vec}`
    )
  }
  lines.push('\\.')
  lines.push('')

  lines.push('COPY seed_meta (key, value) FROM STDIN;')
  lines.push('embedder\tvoyage-3.5')
  lines.push('dimension\t1024')
  lines.push('input_type\tdocument')
  lines.push('\\.')

  const sql = lines.join('\n')

  await new Promise<void>((resolve, reject) => {
    const gz = createGzip()
    const out = createWriteStream('seed/embeddings.sql.gz')
    gz.pipe(out)
    gz.write(sql)
    gz.end()
    out.on('finish', resolve)
    out.on('error', reject)
    gz.on('error', reject)
  })

  console.log(`Seed written to seed/embeddings.sql.gz`)
}

main().catch((err: Error) => {
  console.error(err)
  process.exit(1)
})
