import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET /api/projects/[id]/activity — activity feed from Slack logs + task skill logs
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  const [slackLogs, recentSkillLogs] = await Promise.all([
    prisma.slackLog.findMany({
      where: { projectId: id },
      select: {
        id: true,
        messageSent: true,
        channel: true,
        delivered: true,
        taskId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.taskSkillLog.findMany({
      where: { task: { projectId: id } },
      select: {
        id: true,
        collaboratorName: true,
        conclusion: true,
        approved: true,
        startedAt: true,
        taskId: true,
      },
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
  ])

  // Merge and sort by date
  const activity = [
    ...slackLogs.map((log) => ({
      id: log.id,
      type: 'slack' as const,
      message: log.messageSent,
      channel: log.channel,
      delivered: log.delivered,
      taskId: log.taskId,
      timestamp: log.createdAt,
    })),
    ...recentSkillLogs.map((log) => ({
      id: log.id,
      type: 'skill' as const,
      message: `${log.collaboratorName}: ${log.conclusion?.slice(0, 200) ?? 'Processing...'}`,
      approved: log.approved,
      taskId: log.taskId,
      timestamp: log.startedAt,
    })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 50)

  return NextResponse.json(activity)
}
