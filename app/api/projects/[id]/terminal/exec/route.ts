import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { execInSandbox } from '@/lib/sandbox-manager'

interface RouteContext {
  params: Promise<{ id: string }>
}

// POST — execute a command in the sandbox.
//
// Behavior:
//   - Without query params → runs in /home/user/project (shared main tree)
//   - With ?worktree=ID    → runs inside that worktree's directory
//   - With ?session=ID     → resolves to the parent worktree of that chat
//                            (if any), otherwise main
//
// When a worktree is resolved, BORNASTAR_PORT (and PORT alias) are injected
// so dev servers don't collide across worktrees.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { command: string }
  if (!body.command?.trim()) {
    return NextResponse.json({ error: 'Command is required' }, { status: 400 })
  }

  // Resolve worktree from explicit ?worktree= or via ?session= → chat.worktree
  const worktreeIdParam = request.nextUrl.searchParams.get('worktree')
  const sessionId = request.nextUrl.searchParams.get('session')

  let cwd: string | undefined
  let env: Record<string, string> | undefined

  if (worktreeIdParam) {
    const wt = await prisma.worktree.findUnique({
      where: { id: worktreeIdParam },
      select: { projectId: true, worktreePath: true, portBase: true },
    })
    if (wt && wt.projectId === id) {
      if (wt.worktreePath) cwd = wt.worktreePath
      if (wt.portBase != null) {
        env = {
          BORNASTAR_PORT: String(wt.portBase),
          BORNASTAR_PORT_END: String(wt.portBase + 9),
          PORT: String(wt.portBase),
        }
      }
    }
  } else if (sessionId) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        projectId: true,
        worktree: { select: { worktreePath: true, portBase: true } },
      },
    })
    if (session && session.projectId === id && session.worktree) {
      if (session.worktree.worktreePath) cwd = session.worktree.worktreePath
      if (session.worktree.portBase != null) {
        env = {
          BORNASTAR_PORT: String(session.worktree.portBase),
          BORNASTAR_PORT_END: String(session.worktree.portBase + 9),
          PORT: String(session.worktree.portBase),
        }
      }
    }
  }

  console.log(`[isolation] terminal exec worktree=${worktreeIdParam?.slice(0, 8) ?? '(main)'} cwd=${cwd ?? '(project root)'} port=${env?.BORNASTAR_PORT ?? '-'} cmd="${body.command.slice(0, 60)}"`)

  try {
    const result = await execInSandbox(id, body.command, { cwd, env })

    await prisma.resourceUsage.create({
      data: {
        userId: access.userId,
        projectId: id,
        cpuSeconds: 1,
      },
    })

    return NextResponse.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    })
  } catch (err) {
    return NextResponse.json({
      error: `Execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }, { status: 500 })
  }
}
