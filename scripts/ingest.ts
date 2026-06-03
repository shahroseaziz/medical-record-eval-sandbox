#!/usr/bin/env tsx
/**
 * Maintainer-run ingest + seed-dump generator.
 *
 * Normal mode:
 *   CORPUS_URL=<url-to-tar.gz> DATABASE_URL=<pg-url> npm run ingest
 *   Downloads the corpus archive, parses+embeds each XML, writes patients/chunks
 *   to the DB, then dumps seed/embeddings.sql.gz.
 *
 * Dry-run mode (no DB, no Voyage key required to test parsing):
 *   VOYAGE_API_KEY=<key> npm run ingest -- --dry-run
 *   Processes the 3 committed fixtures, logs what would be written, no output files.
 */

import {
  readFileSync,
  readdirSync,
  mkdirSync,
  createWriteStream,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import { parseCcda } from '../src/lib/ccda/index';
import type { ParseResult } from '../src/lib/ccda/types';
import { embed } from '../src/lib/voyage';
import { SCHEMA_SQL, sql, upsertPatient, insertChunks } from '../src/lib/db';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const DRY_RUN = process.argv.includes('--dry-run');
const EMBED_BATCH = 128;

// ── COPY format helpers ────────────────────────────────────────────────────

function copyEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

function copyBlock(table: string, columns: string[], rows: string[][]): string {
  const lines = [`COPY ${table} (${columns.join(', ')}) FROM stdin;`];
  for (const row of rows) lines.push(row.map(copyEscape).join('\t'));
  lines.push('\\.');
  return lines.join('\n');
}

// ── Embedding ──────────────────────────────────────────────────────────────

async function embedBatched(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    process.stdout.write(
      `  embedding ${i + 1}–${Math.min(i + EMBED_BATCH, texts.length)} / ${texts.length}\r`,
    );
    results.push(...(await embed(batch, 'document')));
  }
  if (texts.length > 0) process.stdout.write('\n');
  return results;
}

// ── Corpus acquisition ─────────────────────────────────────────────────────

async function downloadCorpusXmls(
  url: string,
): Promise<{ name: string; content: string }[]> {
  console.log(`Downloading corpus from ${url} ...`);
  const resp = await fetch(url);
  if (!resp.ok)
    throw new Error(`Corpus fetch failed: ${resp.status} ${resp.statusText}`);

  const tmpDir = mkdtempSync(join(tmpdir(), 'corpus-'));
  const archivePath = join(tmpDir, 'corpus.tar.gz');

  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(archivePath, buf);
  console.log(`  ${(buf.length / 1024 / 1024).toFixed(1)} MB downloaded`);

  execSync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { stdio: 'inherit' });

  const xmls: { name: string; content: string }[] = [];
  function collect(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.xml'))
        xmls.push({ name: entry.name, content: readFileSync(full, 'utf-8') });
    }
  }
  collect(tmpDir);
  rmSync(tmpDir, { recursive: true });
  return xmls;
}

// ── Processing ─────────────────────────────────────────────────────────────

async function processXml(
  xml: string,
): Promise<{ result: ParseResult; embeddings: number[][] }> {
  const result = parseCcda(xml);
  const embeddings = await embedBatched(result.chunks.map((c) => c.text));
  return { result, embeddings };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // ── Dry-run ──────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    console.log('[dry-run] Processing 3 committed fixtures (no DB writes, no dump)');
    const fixturesDir = join(ROOT, 'src/lib/ccda/__fixtures__');
    const xmlFiles = readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.xml'))
      .map((f) => ({
        name: f,
        content: readFileSync(join(fixturesDir, f), 'utf-8'),
      }));

    for (const { name, content } of xmlFiles) {
      console.log(`\n[dry-run] ${name}`);
      const { result, embeddings } = await processXml(content);
      const d = result.demographics;
      console.log(`  patientId : ${result.patientId}`);
      console.log(`  name      : ${d.firstName} ${d.lastName}`);
      console.log(`  gender    : ${d.gender}  birthDate: ${d.birthDate}`);
      console.log(`  sections  : ${result.summary.sections.join(', ')}`);
      console.log(`  chunks    : ${result.chunks.length}  embeddings: ${embeddings.length} × 1024`);
      console.log(
        `  would write: 1 patient row + ${result.chunks.length} chunk rows`,
      );
    }

    console.log('\n[dry-run] Done.');
    return;
  }

  // ── Normal mode ───────────────────────────────────────────────────────────
  const corpusUrl = process.env.CORPUS_URL;
  if (!corpusUrl) throw new Error('CORPUS_URL env var is required');

  const xmlFiles = await downloadCorpusXmls(corpusUrl);
  console.log(`\nProcessing ${xmlFiles.length} XML file(s)...\n`);

  const allPatients: Array<{ id: string; summary: object }> = [];
  const allChunks: Array<{
    patientId: string;
    section: string;
    ord: number;
    text: string;
    embedding: number[];
  }> = [];

  for (const { name, content } of xmlFiles) {
    console.log(`▶ ${name}`);
    const { result, embeddings } = await processXml(content);
    console.log(
      `  patientId=${result.patientId}  chunks=${result.chunks.length}  sections=${result.summary.sections.join(',')}`,
    );
    allPatients.push({ id: result.patientId, summary: result.summary });
    for (let i = 0; i < result.chunks.length; i++) {
      allChunks.push({ ...result.chunks[i], embedding: embeddings[i] });
    }
  }

  // Write to DB
  console.log('\nApplying schema and writing to DB...');
  await sql.unsafe(SCHEMA_SQL, [], { simple: true } as never);
  for (const p of allPatients) await upsertPatient(p.id, p.summary);
  await insertChunks(allChunks);
  console.log(`  ✓ ${allPatients.length} patient(s), ${allChunks.length} chunk(s) written`);

  // Generate seed dump
  console.log('Generating seed/embeddings.sql.gz...');
  const seedDir = join(ROOT, 'seed');
  mkdirSync(seedDir, { recursive: true });

  const patientRows = allPatients.map((p) => [p.id, JSON.stringify(p.summary)]);
  const chunkRows = allChunks.map((c) => [
    c.patientId,
    c.section,
    String(c.ord),
    c.text,
    `[${c.embedding.join(',')}]`,
  ]);
  const metaRows = [
    ['embedder', 'voyage-3.5'],
    ['dimension', '1024'],
    ['input_type', 'document'],
  ];

  const seedSql = [
    SCHEMA_SQL,
    '',
    copyBlock('patients', ['id', 'summary'], patientRows),
    '',
    copyBlock('chunks', ['patient_id', 'section', 'ord', 'text', 'embedding'], chunkRows),
    '',
    copyBlock('seed_meta', ['key', 'value'], metaRows),
    '',
  ].join('\n');

  const outPath = join(seedDir, 'embeddings.sql.gz');
  await pipeline(Readable.from([seedSql]), createGzip(), createWriteStream(outPath));
  console.log(`  ✓ Seed dump written to ${outPath}`);

  await sql.end();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(`\nFatal: ${(err as Error).message}`);
  process.exit(1);
});
