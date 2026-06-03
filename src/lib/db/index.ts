import { Client } from 'pg'

export const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS patients (
  id text PRIMARY KEY, name text, summary jsonb
);
CREATE TABLE IF NOT EXISTS chunks (
  id bigserial PRIMARY KEY,
  patient_id text REFERENCES patients(id),
  section text, ord int, text text,
  embedding vector(1024)
);
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE TABLE IF NOT EXISTS seed_meta (key text PRIMARY KEY, value text);
CREATE TABLE IF NOT EXISTS traces (
  id bigserial PRIMARY KEY, created_at timestamptz DEFAULT now(), trace jsonb
);
`.trim()

export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

export async function applySchema(client: Client): Promise<void> {
  await client.query(SCHEMA_SQL)
}

export async function getSeedMeta(client: Client, key: string): Promise<string | null> {
  const result = await client.query<{ value: string }>(
    'SELECT value FROM seed_meta WHERE key = $1',
    [key]
  )
  return result.rows[0]?.value ?? null
}

export async function setSeedMeta(client: Client, key: string, value: string): Promise<void> {
  await client.query(
    `INSERT INTO seed_meta (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  )
}
