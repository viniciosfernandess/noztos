-- AlterTable
ALTER TABLE "chat_sessions" ADD COLUMN "branchName" TEXT;
ALTER TABLE "chat_sessions" ADD COLUMN "worktreePath" TEXT;
ALTER TABLE "chat_sessions" ADD COLUMN "baseCommit" TEXT;
