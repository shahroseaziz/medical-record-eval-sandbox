const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3.5';
const DIMENSION = 1024;

export async function embed(
  texts: string[],
  inputType: 'document' | 'query',
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY env var is required');

  const resp = await fetch(VOYAGE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      input: texts,
      input_type: inputType,
      output_dimension: DIMENSION,
      output_dtype: 'float',
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Voyage API error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  const embeddings = data.data.map((d) => d.embedding);

  for (const vec of embeddings) {
    if (vec.length !== DIMENSION) {
      throw new Error(
        `Voyage returned vector of length ${vec.length}, expected ${DIMENSION}`,
      );
    }
  }

  return embeddings;
}
