import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { getWorktreeChangedFiles } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string; worktreeId: string }>
}

// GET — list of files changed inside a single worktree, with per-file
// added/removed line counts. Used by the "View this worktree's changes" panel.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const files = await getWorktreeChangedFiles(id, worktreeId)
  return NextResponse.json({ files })
}
