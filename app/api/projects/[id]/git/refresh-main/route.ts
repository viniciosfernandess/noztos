import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, PROJECT_ROOT, runGit } from '@/lib/git'
import { LocalProvider } from '@/lib/compute-local'

const compute = new LocalProvider()

interface RouteContext { params: Promise<{ id: string }> }

// POST — force-refresh the sandbox's main branch to match origin/main.
// Since we killed main-as-a-workspace (all chats live in worktrees now),
// the local main copy is read-only infrastructure and can be reset
// aggressively without risking user work.
//
// Steps:
//   1. `git fetch origin main` — pull latest refs.
//   2. `git reset --hard origin/main` — align local main exactly.
//   3. `git clean -fd` — drop any untracked leftovers.
//   4. Rebuild the cached file tree so the Explorer reflects the new
//      state without extra round trips.
//
// Returns the new commit SHA + refreshed file-tree snapshot so the
// frontend can swap in the updated state in one response.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository / sandbox unavailable' }, { status: 503 })

  // Auth'd remote so private repos work during fetch.
  const remote = ctx.githubToken
    ? `https://${ctx.githubToken}@github.com/${ctx.githubOwner}/${ctx.githubRepo}.git`
    : `https://github.com/${ctx.githubOwner}/${ctx.githubRepo}.git`

  await runGit(ctx.sandboxId, PROJECT_ROOT, `fetch ${remote} main:refs/remotes/origin/main`)
  await runGit(ctx.sandboxId, PROJECT_ROOT, `checkout main 2>&1 || true`)
  const reset = await runGit(ctx.sandboxId, PROJECT_ROOT, `reset --hard origin/main`)
  if ((reset.exitCode ?? 0) !== 0) {
    return NextResponse.json({ error: reset.stderr || 'reset failed' }, { status: 500 })
  }
  await runGit(ctx.sandboxId, PROJECT_ROOT, `clean -fd`)

  // Refresh the persisted file tree so Explorer updates without
  // reloading the project. Mirrors the logic from sandbox-manager's
  // post-clone tree build.
  try {
    const findResult = await compute.exec(
      ctx.sandboxId,
      `find ${PROJECT_ROOT} -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -path '*/__pycache__/*' -not -path '*/.next/*' -not -path '*/dist/*' | sed 's|${PROJECT_ROOT}/||' | sort`,
    )
    if (!findResult.stderr?.includes('SANDBOX_DEAD') && findResult.stdout.trim()) {
      await prisma.repository.update({
        where: { projectId: id },
        data: { fileTree: findResult.stdout.trim(), fileTreeUpdatedAt: new Date() },
      })
    }
  } catch (err) {
    console.warn('[refresh-main] file tree rebuild failed:', err)
  }

  // Current SHA for the caller.
  const sha = await runGit(ctx.sandboxId, PROJECT_ROOT, 'rev-parse HEAD')
  return NextResponse.json({
    ok: true,
    sha: sha.stdout.trim() || null,
    refreshedAt: Date.now(),
  })
}
