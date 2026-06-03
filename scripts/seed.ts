import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'

function unescapeCopyText(s: string): string {
  // PostgreSQL COPY text format escape sequences
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
}

interface CopyBlock {
  table: string
  columns: string[]
  rows: string[][]
}

interface ParsedSeed {
  ddl: string
  copyBlocks: CopyBlock[]
}

export function parseSeedSql(sql: string): ParsedSeed {
  const lines = sql.split('\n')
  const ddlLines: string[] = []
  const copyBlocks: CopyBlock[] = []

  let i = 0
  let inCopy = false
  let current: CopyBlock | null = null

  while (i < lines.length) {
    const line = lines[i]

    if (inCopy) {
      if (line === '\\.') {
        inCopy = false
        copyBlocks.push(current!)
        current = null
      } else if (line.length > 0) {
        current!.rows.push(line.split('\t').map(unescapeCopyText))
      }
    } else {
      const m = line.match(/^COPY\s+(\w+)\s*\(([^)]+)\)\s+FROM\s+STDIN\s*;/i)
      if (m) {
        inCopy = true
        current = {
          table: m[1],
          columns: m[2].split(',').map((s) => s.trim()),
          rows: [],
        }
      } else {
        ddlLines.push(line)
      }
    }

    i++
  }

  return { ddl: ddlLines.join('\n'), copyBlocks }
}

export async function executeSeedSql(client: Client, sql: string): Promise<void> {
  const { ddl, copyBlocks } = parseSeedSql(sql)

  if (ddl.trim()) {
    await client.query(ddl)
  }

  for (const block of copyBlocks) {
    for (const row of block.rows) {
      if (row.length === 0) continue
      const placeholders = block.columns.map((col, i) =>
        col === 'embedding' ? `$${i + 1}::vector` : `$${i + 1}`
      )
      await client.query(
        `INSERT INTO ${block.table} (${block.columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        row
      )
    }
  }
}

export async function checkNotPopulated(client: Client): Promise<void> {
  const tableRes = await client.query<{ exists: boolean }>(
    "SELECT to_regclass('public.patients') IS NOT NULL AS exists"
  )
  if (tableRes.rows[0].exists) {
    const rowRes = await client.query<{ has_rows: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM patients LIMIT 1) AS has_rows'
    )
    if (rowRes.rows[0].has_rows) {
      throw new Error(
        'Database already contains patient data — seed rejected to prevent duplicates. ' +
          'TRUNCATE patients, chunks, seed_meta CASCADE first to re-seed.'
      )
    }
  }
}

export async function loadSeedSql(url: string): Promise<string> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Failed to fetch seed asset: ${resp.status} ${resp.statusText}`)

  const compressed = Buffer.from(await resp.arrayBuffer())
  return new Promise<string>((resolve, reject) => {
    const gz = createGunzip()
    const parts: Buffer[] = []
    gz.on('data', (chunk: Buffer) => parts.push(chunk))
    gz.on('end', () => resolve(Buffer.concat(parts).toString('utf-8')))
    gz.on('error', reject)
    gz.end(compressed)
  })
}

async function main(): Promise<void> {
  const seedUrl = process.env.SEED_URL
  if (!seedUrl) throw new Error('SEED_URL env var required')

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL env var required')

  const preflight = new Client({ connectionString: databaseUrl })
  await preflight.connect()
  try {
    await checkNotPopulated(preflight)
  } finally {
    await preflight.end()
  }

  console.log(`Fetching seed from ${seedUrl}...`)
  const sql = await loadSeedSql(seedUrl)

  console.log('Applying seed...')
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    await executeSeedSql(client, sql)
  } finally {
    await client.end()
  }
  console.log('Seed applied successfully.')
}

// Only run when invoked directly (not when imported by tests)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(err.message)
    process.exit(1)
  })
}
