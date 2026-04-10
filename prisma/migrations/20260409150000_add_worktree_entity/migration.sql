-- CreateTable
CREATE TABLE "worktrees" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'New Worktree',
    "status" TEXT NOT NULL DEFAULT 'open',
    "branchName" TEXT NOT NULL,
    "worktreePath" TEXT NOT NULL,
    "baseCommit" TEXT NOT NULL,
    "portBase" INTEGER,
    "trashedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worktrees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worktrees_projectId_status_idx" ON "worktrees"("projectId", "status");

-- AddForeignKey
ALTER TABLE "worktrees" ADD CONSTRAINT "worktrees_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: ChatSession gets worktreeId, drops the per-chat worktree fields
ALTER TABLE "chat_sessions" ADD COLUMN "worktreeId" TEXT;
ALTER TABLE "chat_sessions" DROP COLUMN "branchName";
ALTER TABLE "chat_sessions" DROP COLUMN "worktreePath";
ALTER TABLE "chat_sessions" DROP COLUMN "baseCommit";
ALTER TABLE "chat_sessions" DROP COLUMN "portBase";

-- CreateIndex
CREATE INDEX "chat_sessions_worktreeId_idx" ON "chat_sessions"("worktreeId");

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_worktreeId_fkey" FOREIGN KEY ("worktreeId") REFERENCES "worktrees"("id") ON DELETE CASCADE ON UPDATE CASCADE;
