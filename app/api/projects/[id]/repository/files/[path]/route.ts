import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { cloudAwareCompute } from '@/lib/compute-router'

// Cloud-aware: when the requested file path falls under a worktree
// whose activeContext='cloud', the router transparently delegates to
// the E2B sandbox. Main-branch paths stay on local.
const compute = cloudAwareCompute

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

  // Resolve which working directory to read from — in local mode this
  // is the actual path on the user's disk.
  const resolvedProjectPath = await ensureSandboxRunning(id)
  if (!resolvedProjectPath) return NextResponse.json({ error: 'Project not available' }, { status: 503 })

  let projectRoot = resolvedProjectPath
  // Conductor-style PR-first model: a worktree's "diff" is the totality of
  // its work vs where the branch was cut from (baseCommit), regardless of
  // whether it's been committed yet. Same reference Changes panel uses
  // (lib/worktree.ts getWorktreeChangedFiles → `git diff <baseCommit>`),
  // so Explorer and Changes show the same set of files. On main view we
  // fall back to HEAD (no baseline notion outside a worktree).
  let diffBase: string | null = null

  if (worktreeIdParam) {
    const wt = await prisma.worktree.findUnique({
      where: { id: worktreeIdParam },
      select: { projectId: true, worktreePath: true, baseCommit: true },
    })
    if (wt && wt.projectId === id && wt.worktreePath) {
      projectRoot = wt.worktreePath
      diffBase = wt.baseCommit ?? null
    }
  } else if (sessionId) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        projectId: true,
        worktree: { select: { worktreePath: true, baseCommit: true } },
      },
    })
    if (session && session.projectId === id && session.worktree?.worktreePath) {
      projectRoot = session.worktree.worktreePath
      diffBase = session.worktree.baseCommit ?? null
    }
  }

  const sandboxId = resolvedProjectPath

  try {
    // The path-traversal boundary is `projectRoot` (the worktree dir or
    // the main project root) — NOT `sandboxId`. With worktrees living
    // outside the repo (~/.bornastar/worktrees/...), a file inside a
    // worktree won't `startsWith(sandboxId)` and the boundary check in
    // compute.readFile would 404 every read. Using projectRoot lets the
    // check still defend against `..` traversal while accommodating
    // worktrees being on a sibling path.
    const content = await compute.readFile(projectRoot, `${projectRoot}/${filePath}`)

    // Get committed version of the file for diff comparison.
    // Worktree → compare against baseCommit (full branch work). Main → HEAD.
    // When `git show <ref>:<path>` fails the file is untracked at that ref —
    // we surface originalContent='' so Explorer's inline diff renders the
    // whole file as added (all green), matching VS Code/Cursor behavior.
    const ref = diffBase ?? 'HEAD'
    let originalContent = ''
    let isModified = false
    try {
      const diffResult = await compute.exec(sandboxId, `cd ${projectRoot} && git show ${ref}:${filePath} 2>/dev/null`)
      if (diffResult.exitCode === 0) {
        originalContent = diffResult.stdout
        isModified = originalContent !== content
      } else {
        isModified = content !== ''
      }
    } catch {
      isModified = content !== ''
    }

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

// PUT — Write content back to a file. Mirrors GET's path resolution:
// ?worktree=ID or ?session=ID routes the write into the correct working
// directory (worktree path or main project root). Body: { content: string }.
export async function PUT(request: NextRequest, { params }: RouteParams) {
  const { id, path: encodedPath } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const filePath = decodeURIComponent(encodedPath)
  const worktreeIdParam = request.nextUrl.searchParams.get('worktree')
  const sessionId = request.nextUrl.searchParams.get('session')

  let body: { content?: string } = {}
  try { body = await request.json() } catch {}
  if (typeof body.content !== 'string') {
    return NextResponse.json({ error: 'content required' }, { status: 400 })
  }

  // Same resolution logic as GET — keep them in lockstep.
  const resolvedPath = await ensureSandboxRunning(id)
  if (!resolvedPath) return NextResponse.json({ error: 'Project not available' }, { status: 503 })

  let projectRoot = resolvedPath

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

  try {
    // Same boundary rationale as GET: validate against projectRoot
    // (the worktree or main path) so worktrees outside the repo work.
    await compute.writeFile(projectRoot, `${projectRoot}/${filePath}`, body.content)
    return NextResponse.json({ ok: true, sizeBytes: Buffer.byteLength(body.content, 'utf-8') })
  } catch {
    return NextResponse.json({ error: 'Failed to write file' }, { status: 500 })
  }
}
