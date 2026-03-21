import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { getSessionUserId } from '@/lib/session'

// GET /api/search?q=...&type=projects|tasks|all&status=...
export async function GET(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q')?.trim()
  const type = searchParams.get('type') ?? 'all'
  const status = searchParams.get('status')

  if (!query || query.length < 2) {
    return NextResponse.json({ error: 'Query must be at least 2 characters' }, { status: 400 })
  }

  const results: { projects?: unknown[]; tasks?: unknown[] } = {}

  if (type === 'all' || type === 'projects') {
    results.projects = await prisma.project.findMany({
      where: {
        userId,
        name: { contains: query, mode: 'insensitive' },
      },
      select: { id: true, name: true, createdAt: true },
      take: 10,
      orderBy: { createdAt: 'desc' },
    })
  }

  if (type === 'all' || type === 'tasks') {
    const taskWhere: Record<string, unknown> = {
      user: { id: userId },
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { instruction: { contains: query, mode: 'insensitive' } },
      ],
    }
    if (status) {
      taskWhere.status = status
    }

    results.tasks = await prisma.task.findMany({
      where: taskWhere,
      select: {
        id: true,
        name: true,
        status: true,
        projectId: true,
        createdAt: true,
      },
      take: 20,
      orderBy: { createdAt: 'desc' },
    })
  }

  return NextResponse.json(results)
}
