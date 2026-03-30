import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { E2BProvider } from '@/lib/compute-e2b'

const compute = new E2BProvider()

interface RouteParams {
  params: Promise<{ id: string; path: string }>
}

// GET — Get a single file's content from the container
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id, path: encodedPath } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const filePath = decodeURIComponent(encodedPath)

  // Ensure sandbox is running
  const sandboxId = await ensureSandboxRunning(id)
  if (!sandboxId) return NextResponse.json({ error: 'Container not available' }, { status: 503 })

  try {
    const content = await compute.readFile(sandboxId, `/home/user/project/${filePath}`)

    // Get git diff for original content (what's committed vs current)
    let originalContent = content
    let isModified = false
    try {
      const diffResult = await compute.exec(sandboxId, `cd /home/user/project && git show HEAD:${filePath} 2>/dev/null`)
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
