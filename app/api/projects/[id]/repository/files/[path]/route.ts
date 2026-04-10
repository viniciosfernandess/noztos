import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { E2BProvider } from '@/lib/compute-e2b'

const compute = new E2BProvider()

interface RouteParams {
  params: Promise<{ id: string; path: string }>
}

// GET — Get a single file's content. When ?session=<id> is passed, reads the
// file from that worktree instead of main, so the user sees the in-progress
// version produced by the agent. Accepts either ?worktree=ID directly or
// ?session=ID (resolved to the chat's parent worktree, if any).
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id, path: encodedPath } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const filePath = decodeURIComponent(encodedPath)
  const worktreeIdParam = request.nextUrl.searchParams.get('worktree')
  const sessionId = request.nextUrl.searchParams.get('session')

  // Resolve which working directory to read from
  let projectRoot = '/home/user/project'

  if (worktreeIdParam) {
    const wt = await prisma.worktree.findUnique({
      where: { id: worktreeIdParam },
      select: { projectId: true, worktreePath: true },
    })
    if (wt && wt.projectId === id && wt.worktreePath) {
      projectRoot = wt.worktreePath
    }
  } else if (sessionId) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        projectId: true,
        worktree: { select: { worktreePath: true } },
      },
    })
    if (session && session.projectId === id && session.worktree?.worktreePath) {
      projectRoot = session.worktree.worktreePath
    }
  }

  const sandboxId = await ensureSandboxRunning(id)
  if (!sandboxId) return NextResponse.json({ error: 'Container not available' }, { status: 503 })

  try {
    const content = await compute.readFile(sandboxId, `${projectRoot}/${filePath}`)

    // Get committed version of the file for diff comparison.
    // For a worktree we compare against its baseCommit; for main we compare against HEAD.
    let originalContent = content
    let isModified = false
    try {
      const diffResult = await compute.exec(sandboxId, `cd ${projectRoot} && git show HEAD:${filePath} 2>/dev/null`)
      if (diffResult.exitCode === 0) {
        originalContent = diffResult.stdout
        isModified = originalContent !== content
      }
    } catch {}

    return NextResponse.json({
      path: filePath,
      content,
      originalContent,
      isModified,
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
    })
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }
}
