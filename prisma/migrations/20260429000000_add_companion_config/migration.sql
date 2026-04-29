-- Singleton row holding the system-prompt config every companion daemon
-- fetches at startup and refreshes via SSE push. See model docstring in
-- schema.prisma for the full rationale.
CREATE TABLE "companion_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "modePrompts" JSONB NOT NULL,
    "namingRule" TEXT NOT NULL,
    "disallowedTools" JSONB NOT NULL,
    "version" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companion_config_pkey" PRIMARY KEY ("id")
);
