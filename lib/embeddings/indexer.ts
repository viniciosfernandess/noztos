// ── Indexer ───────────────────────────────────────────────────────────────
//
// Builds and updates the semantic index for a repository.
//
// buildIndex(projectId)          — full index after clone
// updateIndex(projectId, paths)  — partial update after Agent edits
//
// Uses Voyage AI for embeddings, stores in Supabase via pgvector.

import { prisma } from '@/lib/db'
import { execInSandbox } from '@/lib/sandbox-manager'
import { embedBatch, vectorToSql } from './voyage'
import { chunkFile, type Chunk } from './chunker'

// ── Helpers ───────────────────────────────────────────────────────────────

async function readFileFromSandbox(projectId: string, filePath: string): Promise<string | null> {
  try {
    // Quote the path to handle special characters in directory names (e.g. Next.js route groups like (admin))
    const result = await execInSandbox(projectId, `cat '/home/user/project/${filePath}' 2>/dev/null`)
    if (result.exitCode !== 0 || !result.stdout.trim()) return null
    return result.stdout
  } catch {
    return null
  }
}

async function getRepositoryId(projectId: string): Promise<string | null> {
  const repo = await prisma.repository.findUnique({
    where: { projectId },
    select: { id: true },
  })
  return repo?.id ?? null
}

// ── Store chunks with embeddings ──────────────────────────────────────────

async function storeChunks(repositoryId: string, chunks: Chunk[], embeddings: number[][]): Promise<void> {
  if (chunks.length === 0) return

  // Upsert each chunk — update if exists (file was re-indexed)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const embedding = embeddings[i]
    const vectorStr = vectorToSql(embedding)

    await prisma.$executeRaw`
      INSERT INTO "public"."repo_chunks"
        ("id", "repositoryId", "filePath", "chunkType", "chunkName", "content", "lineStart", "lineEnd", "embedding", "lastModified", "touchCount")
      VALUES
        (gen_random_uuid(), ${repositoryId}, ${chunk.filePath}, ${chunk.chunkType}, ${chunk.chunkName}, ${chunk.content}, ${chunk.lineStart}, ${chunk.lineEnd}, ${vectorStr}::vector, NOW(), 0)
      ON CONFLICT ("repositoryId", "filePath", "chunkName")
      DO UPDATE SET
        "content" = EXCLUDED."content",
        "embedding" = EXCLUDED."embedding",
        "lineStart" = EXCLUDED."lineStart",
        "lineEnd" = EXCLUDED."lineEnd",
        "lastModified" = NOW(),
        "touchCount" = "repo_chunks"."touchCount" + 1
    `
  }
}

async function storeImports(repositoryId: string, chunks: Chunk[]): Promise<void> {
  // Collect unique import relationships
  const seen = new Set<string>()
  const pairs: { file: string; imports: string }[] = []

  for (const chunk of chunks) {
    for (const imp of chunk.imports) {
      const key = `${chunk.filePath}:${imp}`
      if (!seen.has(key)) {
        seen.add(key)
        pairs.push({ file: chunk.filePath, imports: imp })
      }
    }
  }

  if (pairs.length === 0) return

  for (const { file, imports } of pairs) {
    await prisma.$executeRaw`
      INSERT INTO "public"."repo_imports" ("repositoryId", "filePath", "importsPath")
      VALUES (${repositoryId}, ${file}, ${imports})
      ON CONFLICT DO NOTHING
    `
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build the full index after sandbox clone.
 * Reads all files from fileTree, chunks + embeds them.
 */
export async function buildIndex(projectId: string): Promise<void> {
  const repositoryId = await getRepositoryId(projectId)
  if (!repositoryId) return

  const repo = await prisma.repository.findUnique({
    where: { projectId },
    select: { fileTree: true },
  })
  if (!repo?.fileTree) {
    console.log('[indexer] No fileTree — skipping index build')
    return
  }

  const files = repo.fileTree.split('\n').filter(Boolean)
  console.log(`[indexer] Building index for ${files.length} files...`)

  const allChunks: Chunk[] = []

  // Read files and chunk — skip binary/large files
  for (const filePath of files) {
    const content = await readFileFromSandbox(projectId, filePath)
    if (!content) continue
    const chunks = chunkFile(filePath, content)
    allChunks.push(...chunks)
  }

  console.log(`[indexer] ${allChunks.length} chunks from ${files.length} files`)

  if (allChunks.length === 0) return

  // Embed all chunks in one batch call (Voyage handles batching internally)
  const texts = allChunks.map((c) => `${c.filePath}\n${c.chunkName ?? ''}\n${c.content}`)
  const embeddings = await embedBatch(texts)

  await storeChunks(repositoryId, allChunks, embeddings)
  await storeImports(repositoryId, allChunks)

  console.log(`[indexer] Index built: ${allChunks.length} chunks stored`)
}

/**
 * Update the index for specific files after Agent edits.
 * Only re-indexes the touched files — fast and surgical.
 */
export async function updateIndex(projectId: string, filePaths: string[]): Promise<void> {
  if (filePaths.length === 0) return

  const repositoryId = await getRepositoryId(projectId)
  if (!repositoryId) return

  console.log(`[indexer] Updating index for ${filePaths.length} files: [${filePaths.join(', ')}]`)

  const allChunks: Chunk[] = []

  for (const filePath of filePaths) {
    // Delete old chunks for this file first
    await prisma.$executeRaw`
      DELETE FROM "public"."repo_chunks"
      WHERE "repositoryId" = ${repositoryId} AND "filePath" = ${filePath}
    `
    await prisma.$executeRaw`
      DELETE FROM "public"."repo_imports"
      WHERE "repositoryId" = ${repositoryId} AND "filePath" = ${filePath}
    `

    const content = await readFileFromSandbox(projectId, filePath)
    if (!content) continue

    const chunks = chunkFile(filePath, content)
    allChunks.push(...chunks)
  }

  if (allChunks.length === 0) return

  const texts = allChunks.map((c) => `${c.filePath}\n${c.chunkName ?? ''}\n${c.content}`)
  const embeddings = await embedBatch(texts)

  await storeChunks(repositoryId, allChunks, embeddings)
  await storeImports(repositoryId, allChunks)

  console.log(`[indexer] Updated ${allChunks.length} chunks for ${filePaths.length} files`)
}
