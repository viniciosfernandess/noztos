-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Chunks with embeddings (voyage-code-2 = 1536 dims)
CREATE TABLE IF NOT EXISTS "public"."repo_chunks" (
  "id"           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  "repositoryId" TEXT    NOT NULL REFERENCES "public"."repositories"("id") ON DELETE CASCADE,
  "filePath"     TEXT    NOT NULL,
  "chunkType"    TEXT    NOT NULL,
  "chunkName"    TEXT,
  "content"      TEXT    NOT NULL,
  "lineStart"    INT,
  "lineEnd"      INT,
  "embedding"    vector(1536),
  "lastModified" TIMESTAMP DEFAULT NOW(),
  "touchCount"   INT DEFAULT 0,
  UNIQUE ("repositoryId", "filePath", "chunkName")
);

CREATE INDEX IF NOT EXISTS repo_chunks_repo_idx
  ON "public"."repo_chunks" ("repositoryId", "lastModified" DESC);

-- Index for vector similarity search (cosine distance)
-- Using hnsw for better recall on small-medium repos
CREATE INDEX IF NOT EXISTS repo_chunks_embedding_idx
  ON "public"."repo_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- Import graph — tracks which files import which
CREATE TABLE IF NOT EXISTS "public"."repo_imports" (
  "repositoryId" TEXT NOT NULL,
  "filePath"     TEXT NOT NULL,
  "importsPath"  TEXT NOT NULL,
  PRIMARY KEY ("repositoryId", "filePath", "importsPath")
);

CREATE INDEX IF NOT EXISTS repo_imports_file_idx
  ON "public"."repo_imports" ("repositoryId", "filePath");
