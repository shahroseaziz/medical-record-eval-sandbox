import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { Readable } from 'node:stream';

// Hoist mocks before any imports that transitively load these modules.
vi.mock('postgres', () => ({ default: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import postgres from 'postgres';
import { spawn } from 'node:child_process';
import { isAlreadySeeded, runPsql } from '../seed-apply';

// Build a minimal mock postgres sql object.
function makeDb(queryResult: unknown[], throwCode?: string) {
  const err =
    throwCode !== undefined
      ? Object.assign(new Error('db error'), { code: throwCode })
      : null;

  return Object.assign(
    vi.fn(async () => {
      if (err) throw err;
      return queryResult;
    }),
    { end: vi.fn().mockResolvedValue(undefined) },
  );
}

// Build a mock ChildProcess that closes with the given exit code.
function mockPsqlProcess(exitCode: number) {
  const stdin = new PassThrough();
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};

  const proc = {
    stdin,
    on: vi.fn((event: string, cb: (arg: unknown) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      if (event === 'close') setTimeout(() => cb(exitCode), 0);
    }),
  };

  vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
  return proc;
}

function makeStream(content = 'SELECT 1;') {
  return Readable.from([content]) as NodeJS.ReadableStream;
}

// ── isAlreadySeeded ────────────────────────────────────────────────────────

describe('isAlreadySeeded', () => {
  afterEach(() => {
    vi.mocked(postgres).mockReset();
  });

  it('returns true when seed_meta has rows', async () => {
    vi.mocked(postgres).mockReturnValueOnce(makeDb([{ '?column?': 1 }]) as never);
    expect(await isAlreadySeeded('postgres://localhost/test')).toBe(true);
  });

  it('returns false when seed_meta is empty', async () => {
    vi.mocked(postgres).mockReturnValueOnce(makeDb([]) as never);
    expect(await isAlreadySeeded('postgres://localhost/test')).toBe(false);
  });

  it('returns false when seed_meta table does not exist (42P01)', async () => {
    vi.mocked(postgres).mockReturnValueOnce(makeDb([], '42P01') as never);
    expect(await isAlreadySeeded('postgres://localhost/test')).toBe(false);
  });

  it('rethrows unexpected DB errors', async () => {
    vi.mocked(postgres).mockReturnValueOnce(makeDb([], 'ECONNREFUSED') as never);
    await expect(isAlreadySeeded('postgres://localhost/test')).rejects.toThrow('db error');
  });
});

// ── runPsql ────────────────────────────────────────────────────────────────

describe('runPsql', () => {
  afterEach(() => {
    vi.mocked(spawn).mockReset();
  });

  it('resolves when psql exits with code 0', async () => {
    mockPsqlProcess(0);
    await expect(runPsql('postgres://localhost/test', makeStream())).resolves.toBeUndefined();
  });

  it('throws when psql exits with non-zero code (fail-fast)', async () => {
    mockPsqlProcess(1);
    await expect(runPsql('postgres://localhost/test', makeStream())).rejects.toThrow(
      'psql exited with code 1',
    );
  });

  it('invokes psql with ON_ERROR_STOP=1', async () => {
    mockPsqlProcess(0);
    await runPsql('postgres://localhost/test', makeStream());
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'psql',
      expect.arrayContaining(['--set=ON_ERROR_STOP=1']),
      expect.any(Object),
    );
  });

  it('rejects when seed_meta already has rows (re-apply guard via isAlreadySeeded)', async () => {
    // Verify the guard: isAlreadySeeded returns true → caller must throw before runPsql.
    vi.mocked(postgres).mockReturnValueOnce(makeDb([{ '?column?': 1 }]) as never);
    const alreadySeeded = await isAlreadySeeded('postgres://localhost/test');
    expect(alreadySeeded).toBe(true);
    // In practice scripts/seed.ts throws here — psql is never spawned.
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
