const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
export const MODEL = 'voyage-3.5'
export const DIM = 1024

export async function embed(
  texts: string[],
  inputType: 'document' | 'query'
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('VOYAGE_API_KEY env var is required')

  const resp = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: inputType,
      output_dimension: DIM,
      output_dtype: 'float',
    }),
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Voyage API error ${resp.status}: ${body}`)
  }

  const json = (await resp.json()) as { data: Array<{ embedding: number[] }> }
  const vectors = json.data.map((d) => d.embedding)

  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].length !== DIM) {
      throw new Error(
        `Expected embedding dimension ${DIM}, got ${vectors[i].length} for input[${i}]`
      )
    }
  }

  return vectors
}
