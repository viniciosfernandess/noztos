// ── Retriever ─────────────────────────────────────────────────────────────
//
// Semantic retrieval for prefetch context.
//
// Flow:
//   1. Embed question + recent conversation
//   2. Vector similarity search (pgvector cosine distance)
//   3. Mode boost — classifier mode influences which chunks rank higher
//   4. Import graph augmentation — pull direct imports of retrieved files
//   5. Return ranked chunks ready for context injection

import { prisma } from '@/lib/db'
import { embedText } from './voyage'

export interface RetrievedChunk {
  filePath: string
  chunkName: string | null
  chunkType: string
  content: string
  lineStart: number
  lineEnd: number
  score: number
}

// ── Mode boost config ─────────────────────────────────────────────────────
// Which chunk types get a score bonus based on classifier mode

const MODE_BOOSTS: Record<string, { types: string[]; bonus: number }> = {
  debugging:       { types: ['function', 'component'], bonus: 0.1 },
  planning:        { types: ['section', 'config'],     bonus: 0.1 },
  'improving-code': { types: ['function', 'component'], bonus: 0.1 },
  refactoring:     { types: ['function', 'class'],     bonus: 0.1 },
  documentation:   { types: ['section', 'file'],       bonus: 0.15 },
  testing:         { types: ['function', 'component'], bonus: 0.1 },
}

// ── Main retrieval ────────────────────────────────────────────────────────

/**
 * Retrieve the most semantically relevant chunks for a query.
 *
 * @param repositoryId  — DB repository ID
 * @param query         — user's question + recent context
 * @param classifierMode — from the classifier (e.g. 'debugging', 'planning')
 * @param topK          — how many chunks to return (before augmentation)
 */
export async function retrieveChunks(
  repositoryId: string,
  query: string,
  classifierMode: string | null,
  topK = 8,
): Promise<RetrievedChunk[]> {
  // 1. Embed the query
  const queryEmbedding = await embedText(query)
  const vectorStr = `[${queryEmbedding.join(',')}]`

  // 2. Vector similarity search — cosine distance (lower = more similar)
  // Also boost recently-touched chunks (touch_count > 0 = Agent modified them)
  const rows = await prisma.$queryRaw<{
    filePath: string
    chunkName: string | null
    chunkType: string
    content: string
    lineStart: number
    lineEnd: number
    similarity: number
    touchCount: number
  }[]>`
    SELECT
      "filePath",
      "chunkName",
      "chunkType",
      "content",
      "lineStart",
      "lineEnd",
      1 - ("embedding" <=> ${vectorStr}::vector) AS similarity,
      "touchCount"
    FROM "public"."repo_chunks"
    WHERE "repositoryId" = ${repositoryId}
      AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vectorStr}::vector
    LIMIT ${topK * 2}
  `

  if (rows.length === 0) return []

  // 3. Apply mode boost and recency boost
  const modeBoost = classifierMode ? MODE_BOOSTS[classifierMode] : null

  const scored = rows.map((row) => {
    let score = row.similarity

    // Recency boost — Agent recently modified this file
    if (row.touchCount > 0) score += 0.05 * Math.min(row.touchCount, 3)

    // Mode boost — chunk type matches the query mode
    if (modeBoost && modeBoost.types.includes(row.chunkType)) {
      score += modeBoost.bonus
    }

    return { ...row, score }
  })

  // Sort by final score, take top K
  const topChunks = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)

  // 4. Import graph augmentation — for each retrieved file, add its direct imports
  const retrievedPaths = new Set(topChunks.map((c) => c.filePath))
  const augmented: RetrievedChunk[] = [...topChunks]

  const allFilePaths = topChunks.map((c) => c.filePath)
  if (allFilePaths.length > 0) {
    const importRows = await prisma.$queryRaw<{ importsPath: string }[]>`
      SELECT DISTINCT "importsPath"
      FROM "public"."repo_imports"
      WHERE "repositoryId" = ${repositoryId}
        AND "filePath" = ANY(${allFilePaths}::text[])
    `

    for (const { importsPath } of importRows) {
      if (retrievedPaths.has(importsPath)) continue

      // Find the best chunk from this imported file
      const importChunk = await prisma.$queryRaw<{
        filePath: string
        chunkName: string | null
        chunkType: string
        content: string
        lineStart: number
        lineEnd: number
      }[]>`
        SELECT "filePath", "chunkName", "chunkType", "content", "lineStart", "lineEnd"
        FROM "public"."repo_chunks"
        WHERE "repositoryId" = ${repositoryId}
          AND "filePath" = ${importsPath}
        ORDER BY "touchCount" DESC, "lineStart" ASC
        LIMIT 1
      `

      if (importChunk.length > 0) {
        augmented.push({ ...importChunk[0], score: 0.5 }) // import graph score
        retrievedPaths.add(importsPath)
      }

      // Cap augmentation at topK + 3
      if (augmented.length >= topK + 3) break
    }
  }

  return augmented
}

/**
 * Check if the index exists and has chunks for this repository.
 */
export async function hasIndex(repositoryId: string): Promise<boolean> {
  const result = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) as count
    FROM "public"."repo_chunks"
    WHERE "repositoryId" = ${repositoryId}
    LIMIT 1
  `
  return Number(result[0]?.count ?? 0) > 0
}
