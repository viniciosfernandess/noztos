import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { E2BProvider } from '@/lib/compute-e2b'
import { getAllProjectChanges } from '@/lib/worktree'

const compute = new E2BProvider()

interface RouteParams {
  params: Promise<{ id: string }>
}

// GET — List all files in the repository, enriched with cross-worktree
// modification info. Each file gets:
//   - isModified: any open chat has touched it
//   - isNew:      file does not exist on main (only in some worktree)
//   - chats:      [{id, name}] of every chat that touched it
//   - added/removed: aggregated +/- across all chats touching it
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const repo = await prisma.repository.findUnique({ where: { projectId: id } })
  if (!repo) return NextResponse.json({ files: [] })

  const sandboxId = await ensureSandboxRunning(id)
  if (!sandboxId) return NextResponse.json({ files: [], error: 'Container not available' })

  try {
    // Run main file listing and worktree changes in parallel
    const [listResult, changes] = await Promise.all([
      compute.exec(sandboxId, `cd /home/user/project && find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './__pycache__/*' -not -path './venv/*' -not -path './.next/*' -not -path './dist/*' | sed 's|^\\./||' | sort`),
      getAllProjectChanges(id),
    ])

    // Index changes by path for O(1) lookup
    const changeByPath = new Map(changes.files.map((f) => [f.path, f]))
    const mainFiles = listResult.stdout.split('\n').filter(Boolean)
    const mainSet = new Set(mainFiles)

    // Files that exist on main: enrich with change info if any worktree touched them
    const files: Array<{
      id: string
      path: string
      isModified: boolean
      isNew: boolean
      sizeBytes: number
      added?: number
      removed?: number
      worktrees?: { id: string; name: string }[]
    }> = mainFiles.map((path, i) => {
      const change = changeByPath.get(path)
      return {
        id: `file-${i}`,
        path,
        isModified: !!change,
        isNew: false,
        sizeBytes: 0,
        ...(change && {
          added: change.added,
          removed: change.removed,
          worktrees: change.worktrees,
        }),
      }
    })

    // Files that DON'T exist on main but were created by some worktree
    // — surface them too so the tree shows the full project state.
    let extraIdx = 0
    for (const f of changes.files) {
      if (mainSet.has(f.path)) continue
      files.push({
        id: `new-${extraIdx++}`,
        path: f.path,
        isModified: true,
        isNew: true,
        sizeBytes: 0,
        added: f.added,
        removed: f.removed,
        worktrees: f.worktrees,
      })
    }

    files.sort((a, b) => a.path.localeCompare(b.path))
    return NextResponse.json({ files })
  } catch {
    return NextResponse.json({ files: [], error: 'Failed to list files' })
  }
}

// PATCH — File operations (revert, accept, create, rename, delete, move)
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
  if (!sandboxId) return NextResponse.json({ error: 'Container not available' }, { status: 503 })

  const PROJECT_ROOT = '/home/user/project'

  try {
    switch (action) {
      case 'create': {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        if (dir) await compute.exec(sandboxId, `mkdir -p ${PROJECT_ROOT}/${dir}`)
        await compute.writeFile(sandboxId, `${PROJECT_ROOT}/${path}`, body.content ?? '')
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
