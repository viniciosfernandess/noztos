// GET /api/projects/[id]/tasks — list tasks for the project.
//
// Creation lives on /tasks/from-chat (the only intended entry point in
// the new design); this route is read-only. Optional filters:
//   ?status=pending|scheduled|running|done|failed
//   ?worktreeId=<id>          — scope to a worktree (branch)
//   ?limit=N                  — cap result count
//
// Default order: createdAt DESC (newest first), so the TasksPanel can
// drop them straight into columns without re-sorting client-side.

import { NextRequest, NextResponse } from 'next/server'
import { TaskStatus } from '@/generated/prisma/enums'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

const VALID_STATUSES = new Set<TaskStatus>(['pending', 'scheduled', 'running', 'done', 'failed'])

export async function GET(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const statusParam = request.nextUrl.searchParams.get('status')
  const worktreeIdParam = request.nextUrl.searchParams.get('worktreeId')
  const limitParam = request.nextUrl.searchParams.get('limit')
  const take = limitParam ? Math.max(1, Math.min(200, parseInt(limitParam, 10) || 0)) : undefined

  const where: { projectId: string; status?: TaskStatus; worktreeId?: string } = { projectId: id }
  if (statusParam && VALID_STATUSES.has(statusParam as TaskStatus)) {
    where.status = statusParam as TaskStatus
  }
  if (worktreeIdParam) where.worktreeId = worktreeIdParam

  const rows = await prisma.task.findMany({
    where,
    ...(take ? { take } : {}),
    select: {
      id: true,
      name: true,
      instruction: true,
      status: true,
      worktreeId: true,
      executorKind: true,
      executorId: true,
      chatMode: true,
      scheduledAt: true,
      reviewedAt: true,
      sourceTaskId: true,
      createdAt: true,
      updatedAt: true,
      contextSource: true,
      worktree: { select: { branchName: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  // Flatten the worktree join so the client sees branchName as a flat field.
  const tasks = rows.map(({ worktree, ...task }) => ({
    ...task,
    branchName: worktree?.branchName ?? null,
  }))

  return NextResponse.json({ tasks })
}
