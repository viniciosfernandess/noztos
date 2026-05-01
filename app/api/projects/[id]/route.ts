import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { getChannel, getCompanionHomeDir, getCompanionStatus } from '@/lib/companion-relay'
import { cleanupAllProjectWorktrees } from '@/lib/worktree'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — get project info + safety checks for deletion
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      deletedAt: true,
      repository: {
        select: {
          id: true,
          githubOwner: true,
          githubRepo: true,
          files: { where: { isModified: true }, select: { id: true } },
        },
      },
    },
  })

  if (!project || project.deletedAt) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const pendingTasks = await prisma.task.count({ where: { projectId: id, status: { in: ['pending', 'queue', 'progress'] } } })
  const uncommittedChanges = project.repository?.files?.length ?? 0

  return NextResponse.json({
    project: { id: project.id, name: project.name },
    repository: project.repository ? { owner: project.repository.githubOwner, repo: project.repository.githubRepo } : null,
    warnings: {
      uncommittedChanges,
      pendingTasks,
    },
  })
}

// DELETE — permanently remove the project from the user's UI. Soft
// delete in the DB (rows stay for ML / audit), hard delete on disk
// (worktrees + branches removed) and on the daemon (local config row
// dropped, worktrees parent dir rm-rf'd).
//
// Cascade order:
//   1. Find project's worktree rows (we need worktreePath/branchName
//      for disk cleanup BEFORE the cascade flips them to deleted).
//   2. Soft-delete cascade in one Prisma transaction:
//        chatMessages   → deletedAt=now
//        chatSessions   → status=deleted, deletedAt=now
//        worktrees      → status=deleted, deletedAt=now, portBase=null
//        project        → status=deleted, deletedAt=now
//   3. Disk cleanup, daemon-driven via compute.exec:
//        per-worktree   → git worktree remove + git branch -D
//        parent dir     → rm -rf ~/.bornastar/worktrees/<projectId>/
//   4. Daemon command queue:
//        unregister_project → daemon drops local config entry
//        cleanup_project    → daemon rm -rf the worktrees dir (idempotent
//                             with step 3 — covers the daemon-was-offline
//                             case where step 3 was a no-op).
//
// All DB operations are atomic (single transaction). Disk + daemon
// cleanup are best-effort — failure logged, the DB state is the source
// of truth and the register-time reconciliation handles drift.
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  // Look up the project + its worktrees + Repository for path. We need
  // worktreePath/branchName before the cascade, since after we flip
  // worktrees to 'deleted' the disk cleanup helper still works (it
  // reads the values we already pulled here, doesn't query again).
  const project = await prisma.project.findFirst({
    where: { id, userId: access.userId },
    select: {
      id: true,
      deletedAt: true,
      // The user's local-path projects store their disk root in
      // `Repository.sandboxId` (legacy naming — predates the
      // multi-flow picker). Used here both for the daemon's
      // unregister command and for path-based reconciliation later.
      repository: { select: { sandboxId: true } },
      worktrees: {
        where: { deletedAt: null },
        select: { id: true, worktreePath: true, branchName: true },
      },
    },
  })

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  // Idempotency: a second DELETE on an already-deleted project is a no-op
  // success rather than a 404 — the user already got what they wanted.
  if (project.deletedAt) {
    console.log(`[projects] DELETE id=${id.slice(0, 8)} IDEMPOTENT-NOOP (already deleted)`)
    return new NextResponse(null, { status: 204 })
  }

  const tStart = Date.now()
  const sessionIds = (await prisma.chatSession.findMany({
    where: { projectId: id, deletedAt: null },
    select: { id: true },
  })).map((s) => s.id)

  console.log(`[projects] DELETE id=${id.slice(0, 8)} cascade preview worktrees=${project.worktrees.length} sessions=${sessionIds.length}`)

  const now = new Date()
  const tCascade = Date.now()
  const [msgsRes, sessRes, wtRes] = await prisma.$transaction([
    prisma.chatMessage.updateMany({
      where: { sessionId: { in: sessionIds }, deletedAt: null },
      data: { deletedAt: now },
    }),
    prisma.chatSession.updateMany({
      where: { projectId: id, deletedAt: null },
      data: { status: 'deleted', deletedAt: now },
    }),
    prisma.worktree.updateMany({
      where: { projectId: id, deletedAt: null },
      data: { status: 'deleted', deletedAt: now, portBase: null },
    }),
    prisma.project.update({
      where: { id },
      data: { status: 'deleted', deletedAt: now },
    }),
  ])
  console.log(`[projects] DELETE id=${id.slice(0, 8)} cascade DONE messages=${msgsRes.count} sessions=${sessRes.count} worktrees=${wtRes.count} ms=${Date.now() - tCascade}`)

  // Disk + daemon cleanup. Run AFTER the DB transaction commits so the
  // user's UI gets the immediate "project gone" feedback even if the
  // daemon is slow / offline — disk inconsistency is recoverable, DB
  // is the source of truth.
  const homeDir = getCompanionHomeDir(access.userId)
  const channel = getChannel(access.userId)
  const daemonOnline = getCompanionStatus(access.userId).connected

  if (daemonOnline) {
    // Daemon is reachable — clean disk inline (best-effort, never throws).
    console.log(`[projects] DELETE id=${id.slice(0, 8)} disk cleanup INLINE (daemon online)`)
    void cleanupAllProjectWorktrees(id, project.worktrees, homeDir).catch((err) => {
      console.warn(`[project-delete] cleanup threw projectId=${id.slice(0, 8)}: ${(err as Error).message}`)
    })
  } else if (homeDir) {
    // Daemon offline — enqueue cleanup so it runs when the daemon
    // reconnects. Reconciliation at register time also catches this
    // (belt + suspenders).
    console.log(`[projects] DELETE id=${id.slice(0, 8)} disk cleanup QUEUED (daemon offline)`)
    channel.pushCommand({
      type: 'cleanup_project',
      worktreesPath: `${homeDir}/.bornastar/worktrees/${id}`,
      timestamp: Date.now(),
    })
  } else {
    console.log(`[projects] DELETE id=${id.slice(0, 8)} disk cleanup SKIPPED (no homeDir registered)`)
  }
  // Always drop the local config row, regardless of daemon state. If
  // daemon is offline now, the command waits in the queue and runs on
  // reconnect; reconcileProjects in register/route.ts also covers it.
  const localPath = project.repository?.sandboxId
  if (localPath) {
    console.log(`[projects] DELETE id=${id.slice(0, 8)} queue unregister_project path=${localPath}`)
    channel.pushCommand({
      type: 'unregister_project',
      targetPath: localPath,
      timestamp: Date.now(),
    })
  }
  console.log(`[projects] DELETE id=${id.slice(0, 8)} TOTAL ms=${Date.now() - tStart}`)

  return new NextResponse(null, { status: 204 })
}
