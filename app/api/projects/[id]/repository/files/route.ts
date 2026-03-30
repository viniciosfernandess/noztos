import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { E2BProvider } from '@/lib/compute-e2b'

const compute = new E2BProvider()

interface RouteParams {
  params: Promise<{ id: string }>
}

// GET — List all files from container
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const repo = await prisma.repository.findUnique({ where: { projectId: id } })
  if (!repo) return NextResponse.json({ files: [] })

  const sandboxId = await ensureSandboxRunning(id)
  if (!sandboxId) return NextResponse.json({ files: [], error: 'Container not available' })

  try {
    // Get all tracked files from git + modified/untracked
    const result = await compute.exec(sandboxId, `cd /home/user/project && find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './__pycache__/*' -not -path './venv/*' -not -path './.next/*' -not -path './dist/*' | sed 's|^\\./||' | sort`)

    // Get modified files from git
    const modifiedResult = await compute.exec(sandboxId, `cd /home/user/project && git diff --name-only 2>/dev/null && git ls-files --others --exclude-standard 2>/dev/null`)
    const modifiedFiles = new Set(modifiedResult.stdout.split('\n').filter(Boolean))

    const files = result.stdout.split('\n').filter(Boolean).map((path, i) => ({
      id: `file-${i}`,
      path,
      isModified: modifiedFiles.has(path),
      isNew: false, // Could check with git ls-files --others
      sizeBytes: 0,
    }))

    return NextResponse.json({ files })
  } catch (err) {
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
