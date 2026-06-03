#!/usr/bin/env tsx
/**
 * Seed-apply script — used by CI and forkers to populate a fresh database.
 *
 *   SEED_URL=<url-to-embeddings.sql.gz> DATABASE_URL=<pg-url> npm run seed
 *
 * Guards:
 *  - Rejects if seed_meta already has rows (re-apply protection).
 *  - Passes ON_ERROR_STOP=1 to psql so any SQL error stops the import.
 */

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { isAlreadySeeded, runPsql } from '../src/lib/seed-apply';

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL env var is required');

  const seedUrl = process.env.SEED_URL;
  if (!seedUrl)
    throw new Error('SEED_URL env var is required (URL to embeddings.sql.gz)');

  console.log('Checking database state...');
  if (await isAlreadySeeded(dbUrl)) {
    throw new Error(
      'Database is already seeded (seed_meta has rows). ' +
        'Drop the database or use a fresh instance before reseeding.',
    );
  }

  console.log(`Fetching seed from: ${seedUrl}`);
  const resp = await fetch(seedUrl);
  if (!resp.ok)
    throw new Error(`Failed to fetch seed asset: ${resp.status} ${resp.statusText}`);
  if (!resp.body) throw new Error('Response body is null');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nodeStream = Readable.fromWeb(resp.body as any);
  const gunzip = createGunzip();
  nodeStream.pipe(gunzip);

  console.log('Applying seed via psql (ON_ERROR_STOP=1)...');
  await runPsql(dbUrl, gunzip);
  console.log('Seed applied successfully.');
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
