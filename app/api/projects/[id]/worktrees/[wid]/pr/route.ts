import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { createPullRequest, findPullRequestForBranch, loadProjectGitContext } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; wid: string }> }

// GET — fetch the current PR state for this worktree's branch (latest PR
// touching that head ref). Used by the Checks panel polling loop.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, wid } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: wid },
    select: { projectId: true, branchName: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'worktree not found' }, { status: 404 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })

  const pr = await findPullRequestForBranch(ctx.githubOwner, ctx.githubRepo, wt.branchName, ctx.githubToken)
  return NextResponse.json({ pr })
}

// POST — create a new PR from this worktree's branch into main. Body:
//   { title: string; body?: string; draft?: boolean; base?: string }
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, wid } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: wid },
    select: { projectId: true, branchName: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'worktree not found' }, { status: 404 })

  let body: { title?: string; body?: string; draft?: boolean; base?: string } = {}
  try { body = await request.json() } catch {}
  if (!body.title?.trim()) return NextResponse.json({ error: 'title required' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })
  if (!ctx.githubToken) return NextResponse.json({ error: 'GitHub not connected', code: 'no_auth' }, { status: 401 })

  const res = await createPullRequest(ctx.githubOwner, ctx.githubRepo, ctx.githubToken, {
    title: body.title.trim(),
    body: body.body ?? '',
    head: wt.branchName,
    base: body.base?.trim() || 'main',
    draft: !!body.draft,
  })
  if (!res.ok) return NextResponse.json({ error: res.error, status: res.status }, { status: res.status >= 400 ? res.status : 500 })

  return NextResponse.json({ pr: res.pr }, { status: 201 })
}
