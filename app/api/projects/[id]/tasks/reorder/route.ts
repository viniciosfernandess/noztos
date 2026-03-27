import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// POST — reorder anytime tasks in queue
// Body: { taskIds: string[] } — ordered list of task IDs (first = highest priority)
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { taskIds: string[] }
  if (!body.taskIds || !Array.isArray(body.taskIds)) {
    return NextResponse.json({ error: 'taskIds array is required' }, { status: 400 })
  }

  // Update each task's queuePosition
  await Promise.all(
    body.taskIds.map((taskId, index) =>
      prisma.task.updateMany({
        where: { id: taskId, projectId: id, status: 'queue' },
        data: { queuePosition: index },
      })
    )
  )

  return NextResponse.json({ ok: true })
}
