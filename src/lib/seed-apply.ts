import postgres from 'postgres';
import { spawn } from 'node:child_process';

/**
 * Returns true when seed_meta already has rows (seed was previously applied).
 * Returns false when the table is missing (42P01) or empty.
 */
export async function isAlreadySeeded(dbUrl: string): Promise<boolean> {
  const db = postgres(dbUrl, { max: 1 });
  try {
    const rows = await db`SELECT 1 FROM seed_meta LIMIT 1`;
    return rows.length > 0;
  } catch (err) {
    // relation does not exist → not seeded yet
    if ((err as { code?: string }).code === '42P01') return false;
    throw err;
  } finally {
    await db.end();
  }
}

/**
 * Pipes sqlStream into psql with ON_ERROR_STOP=1.
 * Rejects if psql exits non-zero (fail-fast on first SQL error).
 */
export async function runPsql(
  dbUrl: string,
  sqlStream: NodeJS.ReadableStream,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const psql = spawn('psql', ['--set=ON_ERROR_STOP=1', dbUrl], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    if (!psql.stdin) {
      reject(new Error('psql stdin is null'));
      return;
    }

    sqlStream.pipe(psql.stdin);

    psql.on('close', (code) => {
      if (code !== 0) reject(new Error(`psql exited with code ${code}`));
      else resolve();
    });
    psql.on('error', (err) =>
      reject(new Error(`Failed to spawn psql: ${err.message}`)),
    );
  });
}
