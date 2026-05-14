// Next.js instrumentation hook — runs once when the server process boots,
// before any request handler is registered. We use it to warm caches
// that would otherwise pay their first-miss latency on the first user
// request. Keep this file small and conservative: blocking work here
// delays the server going healthy in dev / cold-starts in prod.

export async function register() {
  // Only run server-side. Next invokes register() in both runtimes
  // (nodejs and edge) on first init; the edge runtime can't reach
  // Postgres directly, so guard on the runtime env.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  try {
    // Pulled lazily so the import (which transitively pulls Prisma)
    // doesn't run in the edge build pipeline.
    const { ensureSkillCacheLoaded } = await import('@/lib/prompts')
    await ensureSkillCacheLoaded()
    console.log('[instrumentation] skill cache preloaded')
  } catch (err) {
    // Don't fail boot if the cache warm-up errors — the lazy fallback
    // inside getSkillPrompt still works, callers will pay the first-miss
    // cost on first request instead of getting a cold-start crash.
    console.warn('[instrumentation] skill cache preload failed:', (err as Error).message)
  }

  try {
    const { startTaskScheduler } = await import('@/lib/tasks/scheduler')
    startTaskScheduler()
  } catch (err) {
    console.warn('[instrumentation] task scheduler start failed:', (err as Error).message)
  }
}
