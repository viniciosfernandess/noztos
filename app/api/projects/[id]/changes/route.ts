import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { getAllProjectChanges } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — every modified file across every open chat session in this project.
// Each file carries the list of sessions that touched it, plus aggregated
// added/removed line counts. Used by the file tree (center) and the global
// changes list (right panel).
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const changes = await getAllProjectChanges(id)
  return NextResponse.json(changes)
}
