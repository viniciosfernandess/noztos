import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { LocalProvider } from '@/lib/compute-local'
import { getWorktreeChangedFiles } from '@/lib/worktree'

const compute = new LocalProvider()

interface RouteParams {
  params: Promise<{ id: string }>
}

// Resolve which working directory a request should operate in.
// ?worktree=ID  → that worktree's path (full isolation)
// ?session=ID   → the chat's parent worktree if any (fallback to main)
// otherwise     → project root (main)
async function resolveRoot(
  projectId: string,
  sandboxId: string,
  worktreeIdParam: string | null,
  sessionIdParam: string | null,
): Promise<{ root: string; worktreeId: string | null }> {
  if (worktreeIdParam) {
    const wt = await prisma.worktree.findUnique({
      where: { id: worktreeIdParam },
      select: { projectId: true, worktreePath: true },
    })
    if (wt && wt.projectId === projectId && wt.worktreePath) {
      return { root: wt.worktreePath, worktreeId: worktreeIdParam }
    }
  } else if (sessionIdParam) {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionIdParam },
      select: {
        projectId: true,
        worktreeId: true,
        worktree: { select: { worktreePath: true } },
      },
    })
    if (session && session.projectId === projectId && session.worktree?.worktreePath) {
      return { root: session.worktree.worktreePath, worktreeId: session.worktreeId }
    }
  }
  return { root: sandboxId, worktreeId: null }
}

// GET — List files. Scope depends on query:
//   ?worktree=ID → only that worktree's tree + its own diffs vs baseCommit
//   (no param)   → main tree + cross-worktree change aggregation
export async function GET(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const repo = await prisma.repository.findUnique({ where: { projectId: id } })
  if (!repo) return NextResponse.json({ files: [] })

  const sandboxId = await ensureSandboxRunning(id)
  if (!sandboxId) return NextResponse.json({ files: [], error: 'Project not available' })

  const worktreeIdParam = request.nextUrl.searchParams.get('worktree')
  const sessionIdParam = request.nextUrl.searchParams.get('session')
  const { root, worktreeId } = await resolveRoot(id, sandboxId, worktreeIdParam, sessionIdParam)

  console.log(`[isolation] files GET scope=${worktreeId ? 'worktree' : 'main'} worktree=${worktreeId?.slice(0, 8) ?? '-'} root=${root}`)

  try {
    const listResult = await compute.exec(sandboxId, `cd ${root} && find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './__pycache__/*' -not -path './venv/*' -not -path './.next/*' -not -path './dist/*' -not -path './.team-handoff/*' | sed 's|^\\./||' | sort`)
    const diskFiles = listResult.stdout.split('\n').filter(Boolean)
    const diskSet = new Set(diskFiles)

    // Per-worktree view: changes only for this worktree (vs its baseCommit).
    if (worktreeId) {
      const wtChanges = await getWorktreeChangedFiles(id, worktreeId)
      const changeByPath = new Map(wtChanges.map((f) => [f.path, f]))
      // Set of paths touched by Task iterations since the last commit
      // on this worktree. Drives the "T" badge in the Changes list,
      // alongside the existing "U" (uncommitted) badge. Cleared by
      // /api/projects/[id]/git/commit on a successful commit so the
      // badges drop together.
      const wt = await prisma.worktree.findUnique({
        where: { id: worktreeId },
        select: { taskTouchedPaths: true },
      })
      const taskTouchedSet = new Set<string>(
        Array.isArray(wt?.taskTouchedPaths)
          ? (wt.taskTouchedPaths as unknown[]).filter((p): p is string => typeof p === 'string')
          : [],
      )
      const files: Array<{
        id: string; path: string; isModified: boolean; isNew: boolean; sizeBytes: number
        added?: number; removed?: number; uncommitted?: boolean
        touchedByTask?: boolean
        worktrees?: { id: string; name: string }[]
      }> = diskFiles.map((path, i) => {
        const c = changeByPath.get(path)
        return {
          id: `file-${i}`,
          path,
          isModified: !!c,
          isNew: c?.status === 'A',
          sizeBytes: 0,
          ...(c && { added: c.added, removed: c.removed, uncommitted: c.uncommitted }),
          ...(taskTouchedSet.has(path) && { touchedByTask: true }),
        }
      })
      // Deleted files (don't exist on disk but show in git diff as 'D')
      let extraIdx = 0
      for (const c of wtChanges) {
        if (c.status === 'D' && !diskSet.has(c.path)) {
          files.push({
            id: `del-${extraIdx++}`,
            path: c.path,
            isModified: true,
            isNew: false,
            sizeBytes: 0,
            added: c.added,
            removed: c.removed,
            uncommitted: c.uncommitted,
            ...(taskTouchedSet.has(c.path) && { touchedByTask: true }),
          })
        }
      }
      files.sort((a, b) => a.path.localeCompare(b.path))
      return NextResponse.json({ files })
    }

    // Main view: pure snapshot of the main tree on disk. Worktrees live on
    // their own branches/dirs — we don't leak their state here because main
    // can be on a newer commit, making cross-branch +/- numbers misleading.
    // Users see worktree changes only by selecting the worktree.
    const files = diskFiles.map((path, i) => ({
      id: `file-${i}`,
      path,
      isModified: false,
      isNew: false,
      sizeBytes: 0,
    }))

    files.sort((a, b) => a.path.localeCompare(b.path))
    return NextResponse.json({ files })
  } catch {
    return NextResponse.json({ files: [], error: 'Failed to list files' })
  }
}

// PATCH — File operations (revert, accept, create, rename, delete, move).
// Accepts ?worktree=ID / ?session=ID to scope operations into the correct
// working directory so edits never leak between branches.
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = (await request.json()) as {
    path: string
    action: 'revert' | 'accept' | 'create' | 'rename' | 'delete' | 'move'
    content?: string
    newName?: string
    newPath?: string
  }

  const { path, action } = body
  if (!path || !action) return NextResponse.json({ error: 'path and action required' }, { status: 400 })

  const sandboxId = await ensureSandboxRunning(id)
  if (!sandboxId) return NextResponse.json({ error: 'Project not available' }, { status: 503 })

  const worktreeIdParam = request.nextUrl.searchParams.get('worktree')
  const sessionIdParam = request.nextUrl.searchParams.get('session')
  const { root: PROJECT_ROOT } = await resolveRoot(id, sandboxId, worktreeIdParam, sessionIdParam)

  try {
    switch (action) {
      case 'create': {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        if (dir) await compute.exec(sandboxId, `mkdir -p ${PROJECT_ROOT}/${dir}`)
        // Boundary is PROJECT_ROOT (the worktree dir or main path), NOT
        // sandboxId. Worktrees outside the repo wouldn't pass the
        // startsWith(sandboxId) check otherwise.
        await compute.writeFile(PROJECT_ROOT, `${PROJECT_ROOT}/${path}`, body.content ?? '')
        return NextResponse.json({ success: true })
      }

      case 'delete': {
        await compute.exec(sandboxId, `rm -f ${PROJECT_ROOT}/${path}`)
        return NextResponse.json({ success: true })
      }

      case 'rename': {
        if (!body.newName) return NextResponse.json({ error: 'newName required' }, { status: 400 })
        const parts = path.split('/')
        parts[parts.length - 1] = body.newName
        const newPath = parts.join('/')
        await compute.exec(sandboxId, `mv ${PROJECT_ROOT}/${path} ${PROJECT_ROOT}/${newPath}`)
        return NextResponse.json({ success: true, newPath })
      }

      case 'move': {
        if (!body.newPath) return NextResponse.json({ error: 'newPath required' }, { status: 400 })
        const newDir = body.newPath.includes('/') ? body.newPath.slice(0, body.newPath.lastIndexOf('/')) : ''
        if (newDir) await compute.exec(sandboxId, `mkdir -p ${PROJECT_ROOT}/${newDir}`)
        await compute.exec(sandboxId, `mv ${PROJECT_ROOT}/${path} ${PROJECT_ROOT}/${body.newPath}`)
        return NextResponse.json({ success: true, newPath: body.newPath })
      }

      case 'revert': {
        // Revert to last committed version
        const result = await compute.exec(sandboxId, `cd ${PROJECT_ROOT} && git checkout -- ${path} 2>/dev/null`)
        if (result.exitCode !== 0) {
          // New file — just delete
          await compute.exec(sandboxId, `rm -f ${PROJECT_ROOT}/${path}`)
          return NextResponse.json({ success: true, deleted: true })
        }
        return NextResponse.json({ success: true })
      }

      case 'accept': {
        // Stage the file (git add) — marks it as accepted
        await compute.exec(sandboxId, `cd ${PROJECT_ROOT} && git add ${path}`)
        return NextResponse.json({ success: true })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (err) {
    return NextResponse.json({ error: `Operation failed: ${err instanceof Error ? err.message : 'Unknown'}` }, { status: 500 })
  }
}
