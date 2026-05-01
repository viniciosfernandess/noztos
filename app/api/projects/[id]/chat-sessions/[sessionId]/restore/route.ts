import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>
}

// POST — restore an archived chat back to the open list. Worktree was
// preserved during archive, so the chat comes back with every file
// change still in place. The user can pick up exactly where they left
// off. Deleted chats have no restore path: their worktree's on-disk
// folder and branch were removed at delete time.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, sessionId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: {
      projectId: true, status: true, worktreeId: true,
      worktree: { select: { status: true } },
    },
  })
  if (!session || session.projectId !== id) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (session.status !== 'archived') {
    return NextResponse.json({ error: 'Cannot restore — session is not archived' }, { status: 400 })
  }

  // Can't restore a chat whose parent worktree is still archived — that
  // would leave an "open" chat orphaned inside an archived worktree.
  // The UI in ArchivedModal already hides the chat restore button when
  // the worktree is grouped; this guards direct API calls.
  if (session.worktree && session.worktree.status !== 'open') {
    return NextResponse.json(
      { error: 'Cannot restore chat — its worktree is also archived. Restore the worktree instead.' },
      { status: 409 },
    )
  }

  await prisma.chatSession.update({
    where: { id: sessionId },
    data: { status: 'open' },
  })
  console.log(`[chat-restore] sessionId=${sessionId.slice(0, 8)} worktreeId=${session.worktreeId?.slice(0, 8) ?? '-'}`)

  return NextResponse.json({ success: true })
}
