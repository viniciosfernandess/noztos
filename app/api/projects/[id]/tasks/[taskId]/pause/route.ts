import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { releaseRepoLock } from '@/lib/repo-lock'

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>
}

// POST — pause a running task
// Body: { mode: 'continue' | 'restart' | 'delete' }
export async function POST(request: NextRequest, context: RouteContext) {
  const { id, taskId } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { mode: 'continue' | 'restart' | 'delete' }
  const mode = body.mode ?? 'restart'

  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId: id, status: 'progress' },
    include: { project: { include: { repository: true } } },
  })

  if (!task) {
    return NextResponse.json({ error: 'No running task found' }, { status: 404 })
  }

  // Get logs for this execution
  const skillLogs = await prisma.taskSkillLog.findMany({
    where: { taskId },
    select: { collaboratorName: true, conclusion: true, finishedAt: true },
    orderBy: { startedAt: 'asc' },
  })

  const buildLogs = await prisma.taskBuildLog.findMany({
    where: { taskId },
    select: { filesTouched: true },
  })

  const filesModified = buildLogs.flatMap((b) => {
    const files = b.filesTouched as { path: string }[]
    return files.map((f) => f.path)
  })
  const uniqueFiles = [...new Set(filesModified)]

  // ── Mode: Delete ────────────────────────────────────────────────
  if (mode === 'delete') {
    // Revert files
    if (task.project.repository && uniqueFiles.length > 0) {
      await revertFiles(task.project.repository.id, uniqueFiles)
    }

    await prisma.task.delete({ where: { id: taskId } })
    await releaseRepoLock(id, 'task')
    await prisma.project.update({ where: { id }, data: { queueStatus: 'paused' } })

    return NextResponse.json({ status: 'deleted' })
  }

  // ── Mode: Restart (from zero) ───────────────────────────────────
  if (mode === 'restart') {
    // Revert files
    if (task.project.repository && uniqueFiles.length > 0) {
      await revertFiles(task.project.repository.id, uniqueFiles)
    }

    // Clear execution logs
    await prisma.taskSkillLog.deleteMany({ where: { taskId } })
    await prisma.taskBuildLog.deleteMany({ where: { taskId } })
    await prisma.taskIteration.deleteMany({ where: { taskId } })

    // Reset to queue, anytime, keep config
    const existing = task.accumulatedContext as Record<string, unknown>
    const { pausedState: _, ...cleanAccumulated } = existing

    await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'queue',
        scheduledAt: null,
        pausedAt: null,
        pausedAtEmployee: null,
        pausedAtIteration: null,
        accumulatedContext: JSON.parse(JSON.stringify(cleanAccumulated)),
      },
    })

    await releaseRepoLock(id, 'task')
    await prisma.project.update({ where: { id }, data: { queueStatus: 'paused' } })

    return NextResponse.json({ status: 'restarted' })
  }

  // ── Mode: Continue (keep changes, save state) ───────────────────
  // Build paused state snapshot
  const completedEmployees = skillLogs
    .filter((l) => l.finishedAt)
    .map((l) => ({ name: l.collaboratorName, output: (l.conclusion ?? '').slice(0, 1000) }))

  const lastActive = skillLogs.find((l) => !l.finishedAt)

  const pausedState = {
    pausedAt: new Date().toISOString(),
    completedEmployees,
    currentEmployee: lastActive?.collaboratorName ?? task.pausedAtEmployee,
    filesModifiedBeforePause: uniqueFiles,
    totalStepsCompleted: skillLogs.filter((l) => l.finishedAt).length,
  }

  const existing = task.accumulatedContext as Record<string, unknown>

  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'queue',
      scheduledAt: null,
      pausedAt: new Date(),
      accumulatedContext: JSON.parse(JSON.stringify({
        ...existing,
        pausedState,
      })),
    },
  })

  await releaseRepoLock(id, 'task')
  await prisma.project.update({ where: { id }, data: { queueStatus: 'paused' } })

  return NextResponse.json({ status: 'paused_continue' })
}

// ── Revert files to originalContent ───────────────────────────────────────

async function revertFiles(repositoryId: string, filePaths: string[]): Promise<void> {
  for (const path of filePaths) {
    const file = await prisma.repoFile.findUnique({
      where: { repositoryId_path: { repositoryId, path } },
      select: { id: true, originalContent: true },
    })
    if (file) {
      await prisma.repoFile.update({
        where: { id: file.id },
        data: {
          content: file.originalContent,
          isModified: false,
        },
      })
    }
  }
}
