import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { execInSandbox } from '@/lib/sandbox-manager'

interface RouteContext {
  params: Promise<{ id: string }>
}

// POST — execute a command (auto-starts sandbox if needed)
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const body = await request.json() as { command: string }
  if (!body.command?.trim()) {
    return NextResponse.json({ error: 'Command is required' }, { status: 400 })
  }

  try {
    const result = await execInSandbox(id, body.command)

    // Track resource usage
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
