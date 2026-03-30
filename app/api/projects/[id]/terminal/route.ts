import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning, stopSandbox } from '@/lib/sandbox-manager'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — get terminal/sandbox status
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const repo = await prisma.repository.findUnique({
    where: { projectId: id },
    select: { sandboxId: true, sandboxStatus: true, sandboxStartedAt: true, githubOwner: true, githubRepo: true },
  })

  if (!repo) return NextResponse.json({ sandboxId: null, status: null })

  return NextResponse.json({
    sandboxId: repo.sandboxId,
    status: repo.sandboxStatus,
    startedAt: repo.sandboxStartedAt,
    repo: repo.githubOwner && repo.githubRepo ? `${repo.githubOwner}/${repo.githubRepo}` : null,
  })
}

// POST — start sandbox (auto-creates if needed)
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  try {
    const sandboxId = await ensureSandboxRunning(id)
    if (!sandboxId) {
      return NextResponse.json({ error: 'No repository connected or failed to start sandbox' }, { status: 400 })
    }

    return NextResponse.json({ sandboxId, status: 'running' })
  } catch (err) {
    return NextResponse.json({ error: `Failed: ${err instanceof Error ? err.message : 'Unknown error'}` }, { status: 500 })
  }
}

// DELETE — stop sandbox (snapshots to DB first)
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  await stopSandbox(id)
  return NextResponse.json({ status: 'stopped' })
}
