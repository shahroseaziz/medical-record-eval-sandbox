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

COPY seed_meta (key, value) FROM STDIN;
embedder	voyage-3.5
dimension	1024
input_type	document
\.
