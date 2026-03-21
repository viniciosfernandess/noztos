import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// PATCH /api/projects/[id]/settings — update project settings
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  let body: { name?: string; slackChannel?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const data: Record<string, string | null> = {}
  if (body.name?.trim()) {
    if (body.name.trim().length > 100) {
      return NextResponse.json({ error: 'Name must be 100 characters or less' }, { status: 400 })
    }
    data.name = body.name.trim()
  }
  if (body.slackChannel !== undefined) {
    data.slackChannel = body.slackChannel?.trim() || null
  }

  const updated = await prisma.project.update({
    where: { id },
    data,
    select: { id: true, name: true, slackChannel: true },
  })

  return NextResponse.json(updated)
}
