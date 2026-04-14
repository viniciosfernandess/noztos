import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// GET — read the saved PR title/body draft for this worktree.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, prTitleDraft: true, prBodyDraft: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ title: wt.prTitleDraft ?? '', body: wt.prBodyDraft ?? '' })
}

// PATCH — update draft. Body: { title?: string; body?: string }. Either
// field can be cleared with an empty string; omitted fields stay put.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let body: { title?: string; body?: string } = {}
  try { body = await request.json() } catch {}

  const data: { prTitleDraft?: string | null; prBodyDraft?: string | null } = {}
  if (typeof body.title === 'string') data.prTitleDraft = body.title.length > 0 ? body.title : null
  if (typeof body.body === 'string') data.prBodyDraft = body.body.length > 0 ? body.body : null

  const updated = await prisma.worktree.update({
    where: { id: worktreeId },
    data,
    select: { prTitleDraft: true, prBodyDraft: true },
  })
  return NextResponse.json({ title: updated.prTitleDraft ?? '', body: updated.prBodyDraft ?? '' })
}
