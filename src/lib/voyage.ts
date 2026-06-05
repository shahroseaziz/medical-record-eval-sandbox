const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings'
export const MODEL = 'voyage-3.5'
export const DIM = 1024

// Hard wall-clock timeout per embedding call; a hung Voyage request is bounded and surfaced.
const VOYAGE_TIMEOUT_MS = 15_000

// Approximate Voyage-3.5 cost: $0.02 per 1M tokens.
const VOYAGE_COST_PER_TOKEN = 0.02 / 1_000_000

export async function embed(
  texts: string[],
  inputType: 'document' | 'query'
): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY
  if (!apiKey) throw new Error('VOYAGE_API_KEY env var is required')

  const estInputTokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)
  const startMs = Date.now()

  let resp: Response
  try {
    resp = await fetch(VOYAGE_URL, {
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
      signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
    })
  } catch (err) {
    const latencyMs = Date.now() - startMs
    // Structured trace log — no text content logged (PHI guard).
    console.log(JSON.stringify({
      voyage_call: 'embed',
      model: MODEL,
      input_count: texts.length,
      input_type: inputType,
      est_tokens: estInputTokens,
      est_cost_usd: +(estInputTokens * VOYAGE_COST_PER_TOKEN).toFixed(8),
      latency_ms: latencyMs,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    }))
    throw err
  }

  if (!resp.ok) {
    const body = await resp.text()
    const latencyMs = Date.now() - startMs
    console.log(JSON.stringify({
      voyage_call: 'embed',
      model: MODEL,
      input_count: texts.length,
      input_type: inputType,
      est_tokens: estInputTokens,
      est_cost_usd: +(estInputTokens * VOYAGE_COST_PER_TOKEN).toFixed(8),
      latency_ms: latencyMs,
      status: 'api_error',
      http_status: resp.status,
    }))
    throw new Error(`Voyage API error ${resp.status}: ${body}`)
  }

  const json = (await resp.json()) as { data: Array<{ embedding: number[] }>; usage?: { total_tokens?: number } }
  const vectors = json.data.map((d) => d.embedding)
  const latencyMs = Date.now() - startMs

  const actualTokens = json.usage?.total_tokens ?? estInputTokens
  console.log(JSON.stringify({
    voyage_call: 'embed',
    model: MODEL,
    input_count: texts.length,
    input_type: inputType,
    tokens: actualTokens,
    est_cost_usd: +(actualTokens * VOYAGE_COST_PER_TOKEN).toFixed(8),
    latency_ms: latencyMs,
    status: 'ok',
  }))

  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].length !== DIM) {
      throw new Error(
        `Expected embedding dimension ${DIM}, got ${vectors[i].length} for input[${i}]`
      )
    }
  }

  return vectors
}
