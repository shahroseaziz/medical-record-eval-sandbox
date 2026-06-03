import postgres from 'postgres';

export const sql = postgres(process.env.DATABASE_URL ?? '');

// DDL ordered: extension → patients → chunks → traces → seed_meta → index
export const SCHEMA_SQL = `CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  summary JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id BIGSERIAL PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  section TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding vector(1024),
  UNIQUE (patient_id, section, ord)
);

CREATE TABLE IF NOT EXISTS traces (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  score NUMERIC
);

CREATE TABLE IF NOT EXISTS seed_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);`;

export async function upsertPatient(id: string, summary: object): Promise<void> {
  const summaryJson = JSON.stringify(summary);
  await sql`
    INSERT INTO patients (id, summary)
    VALUES (${id}, ${summaryJson}::jsonb)
    ON CONFLICT (id) DO UPDATE SET summary = EXCLUDED.summary
  `;
}

export async function insertChunks(
  chunks: Array<{
    patientId: string;
    section: string;
    ord: number;
    text: string;
    embedding: number[];
  }>,
): Promise<void> {
  for (const c of chunks) {
    const vecStr = `[${c.embedding.join(',')}]`;
    await sql`
      INSERT INTO chunks (patient_id, section, ord, text, embedding)
      VALUES (${c.patientId}, ${c.section}, ${c.ord}, ${c.text}, ${vecStr}::vector)
      ON CONFLICT (patient_id, section, ord) DO UPDATE SET
        text = EXCLUDED.text,
        embedding = EXCLUDED.embedding
    `;
  }
}
