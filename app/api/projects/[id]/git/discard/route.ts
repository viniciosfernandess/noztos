import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { discardPaths, loadProjectGitContext, resolveWorkingDir } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string }> }

// POST — revert paths in the working tree back to HEAD. Takes either an
// explicit list of paths (file / folder prefixes are ok — git handles both)
// or { all: true } to wipe the entire working tree back to HEAD.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { paths?: string[]; all?: boolean; worktreeId?: string | null; sessionId?: string | null } = {}
  try { body = await request.json() } catch {}

  let worktreeId = body.worktreeId ?? null
  if (!worktreeId && body.sessionId) {
    const s = await prisma.chatSession.findUnique({
      where: { id: body.sessionId },
      select: { projectId: true, worktreeId: true },
    })
    if (s && s.projectId === id) worktreeId = s.worktreeId
  }

  const cwd = await resolveWorkingDir(id, worktreeId)
  if (!cwd) return NextResponse.json({ error: 'Unknown worktree' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository / sandbox unavailable' }, { status: 503 })

  const paths = body.all ? ['.'] : (body.paths ?? []).filter((p) => typeof p === 'string' && p.length > 0)
  if (paths.length === 0) return NextResponse.json({ error: 'paths required' }, { status: 400 })

  const ok = await discardPaths(ctx.sandboxId, cwd, paths)
  return NextResponse.json({ ok })
}
