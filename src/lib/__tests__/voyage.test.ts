import { describe, it, expect, vi, afterEach } from 'vitest';
import { embed } from '../voyage';

const DIMENSION = 1024;

function makeVec(len: number): number[] {
  return Array.from({ length: len }, (_, i) => i / Math.max(len, 1));
}

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
  } as Response);
}

describe('embed', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it('throws when VOYAGE_API_KEY is not set', async () => {
    delete process.env.VOYAGE_API_KEY;
    await expect(embed(['hello'], 'document')).rejects.toThrow('VOYAGE_API_KEY');
  });

  it('returns embeddings with correct 1024-dim vectors', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const vec = makeVec(DIMENSION);
    mockFetch(200, { data: [{ embedding: vec }] });

    const result = await embed(['hello'], 'document');
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(DIMENSION);
  });

  it('throws when any returned vector has wrong length (not 1024)', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    mockFetch(200, { data: [{ embedding: makeVec(512) }] });

    await expect(embed(['hello'], 'document')).rejects.toThrow(/expected 1024/);
  });

  it('throws with a useful message on Voyage API HTTP error', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    mockFetch(401, 'Unauthorized');

    await expect(embed(['hello'], 'document')).rejects.toThrow(/Voyage API error 401/);
  });

  it('sends model, input_type, output_dimension, output_dtype in request body', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const fetchSpy = mockFetch(200, { data: [{ embedding: makeVec(DIMENSION) }] });

    await embed(['some text'], 'query');

    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.model).toBe('voyage-3.5');
    expect(body.input_type).toBe('query');
    expect(body.output_dimension).toBe(DIMENSION);
    expect(body.output_dtype).toBe('float');
  });

  it('handles batches with multiple texts', async () => {
    process.env.VOYAGE_API_KEY = 'test-key';
    const vec = makeVec(DIMENSION);
    mockFetch(200, {
      data: [{ embedding: vec }, { embedding: vec }, { embedding: vec }],
    });

    const result = await embed(['a', 'b', 'c'], 'document');
    expect(result).toHaveLength(3);
    result.forEach((v) => expect(v).toHaveLength(DIMENSION));
  });
});
