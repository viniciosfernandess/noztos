// ── Voyage AI Client ──────────────────────────────────────────────────────
//
// voyage-code-2: 1536-dim embeddings optimized for code retrieval
// Docs: https://docs.voyageai.com/reference/embeddings-api
//
// Batches up to 128 texts per request for efficiency.

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings'
const VOYAGE_MODEL = 'voyage-code-2'
const BATCH_SIZE = 64

function getKey(): string {
  const key = process.env.VOYAGE_API_KEY
  if (!key) throw new Error('VOYAGE_API_KEY not set')
  return key
}

/**
 * Embed a single text. Returns a 1536-dim float array.
 */
export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text])
  return embedding
}

/**
 * Embed multiple texts in batches. Returns one vector per text.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []

  const results: number[][] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const res = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getKey()}`,
      },
      body: JSON.stringify({ input: batch, model: VOYAGE_MODEL }),
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Voyage API error ${res.status}: ${err}`)
    }

    const json = await res.json() as { data: { embedding: number[]; index: number }[] }
    // Sort by index to preserve order
    const sorted = json.data.sort((a, b) => a.index - b.index)
    results.push(...sorted.map((d) => d.embedding))
  }

  return results
}

/**
 * Format a vector as a Postgres-compatible string: '[0.1,0.2,...]'
 */
export function vectorToSql(v: number[]): string {
  return `[${v.join(',')}]`
}
