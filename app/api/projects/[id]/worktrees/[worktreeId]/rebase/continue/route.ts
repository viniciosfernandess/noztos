import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, runGit } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// POST — stages any files the user has just finished resolving and
// advances the rebase. If more conflicts appear from later commits in
// the rebase sequence, returns them so the user can keep resolving.
// Body: { files?: string[] }  — files to `git add` before continuing.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, worktreePath: true },
  })
  if (!wt || wt.projectId !== id || !wt.worktreePath) {
    return NextResponse.json({ error: 'worktree not found' }, { status: 404 })
  }

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No sandbox' }, { status: 503 })

  let body: { files?: string[] } = {}
  try { body = await request.json() } catch {}
  const files = (body.files ?? []).filter((f) => typeof f === 'string' && f.length > 0)

  if (files.length > 0) {
    const quoted = files.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(' ')
    await runGit(ctx.sandboxId, wt.worktreePath, `add ${quoted}`)
  }

  // `git -c core.editor=true rebase --continue` skips the commit-message
  // editor so the backend never blocks on an interactive prompt.
  const cont = await runGit(ctx.sandboxId, wt.worktreePath,
    `-c core.editor=true -c merge.conflictStyle=diff3 rebase --continue`)

  if ((cont.exitCode ?? 0) === 0) {
    return NextResponse.json({ status: 'clean' })
  }

  // Another conflict surfaced — same shape as /start returns.
  const statusRes = await runGit(ctx.sandboxId, wt.worktreePath, `diff --name-only --diff-filter=U`)
  const next = statusRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  if (next.length > 0) {
    return NextResponse.json({ status: 'conflict', files: next })
  }

  return NextResponse.json({ error: cont.stderr || cont.stdout || 'continue failed' }, { status: 500 })
}
