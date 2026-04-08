-- AddColumn fileTree to repositories
ALTER TABLE "public"."repositories" ADD COLUMN IF NOT EXISTS "fileTree" TEXT;
ALTER TABLE "public"."repositories" ADD COLUMN IF NOT EXISTS "fileTreeUpdatedAt" TIMESTAMP(3);
