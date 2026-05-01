import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { getSessionUserId } from '@/lib/session'

// POST — create (or idempotently retrieve) a project for the
// authenticated user. Accepts an optional client-minted cuid in the
// body; when present, the call is idempotent across network retries:
//   • first POST  → creates the row with that id
//   • retried POST → upsert finds existing row, returns same id
//
// Without the client id we fall back to the legacy auto-generate path
// (Prisma cuid) — non-idempotent, kept for callers that haven't
// migrated yet.
export async function POST(request: NextRequest) {
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { id?: string; name?: string; slackChannel?: string; slackWebhook?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const name = body.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'Project name is required' }, { status: 400 })
  }

  if (name.length > 100) {
    return NextResponse.json({ error: 'Project name must be 100 characters or less' }, { status: 400 })
  }

  const slackChannel = body.slackChannel?.trim() || null
  const slackWebhook = body.slackWebhook?.trim() || null

  // Cuid validation: must start with 'c', be 20-32 chars, alphanumeric.
  // Tighter than Prisma's default to reject obviously bogus client ids
  // without forcing a heavy regex.
  const clientId = body.id
  if (clientId !== undefined) {
    const valid = typeof clientId === 'string'
      && /^c[a-z0-9]{19,31}$/.test(clientId)
    if (!valid) {
      return NextResponse.json({ error: 'Invalid id (must be a cuid)' }, { status: 400 })
    }
  }

  const tStart = Date.now()
  if (clientId) {
    // Idempotent path: upsert by id, but reject if another user already
    // owns this id (cuid collisions are astronomically unlikely, but the
    // ownership check costs nothing and forecloses the abuse vector).
    const existing = await prisma.project.findUnique({
      where: { id: clientId },
      select: { id: true, userId: true, deletedAt: true },
    })
    if (existing && existing.userId !== userId) {
      console.warn(`[projects] POST upsert REJECTED id=${clientId.slice(0, 8)} reason=other-user`)
      return NextResponse.json({ error: 'Id already in use' }, { status: 409 })
    }
    if (existing && existing.deletedAt) {
      // Reusing a soft-deleted id resurrects an old row, which would
      // pull old children back. Reject — caller should mint a new id.
      console.warn(`[projects] POST upsert REJECTED id=${clientId.slice(0, 8)} reason=soft-deleted`)
      return NextResponse.json({ error: 'Id belongs to a deleted project' }, { status: 409 })
    }
    const project = await prisma.project.upsert({
      where: { id: clientId },
      update: {},  // existing row → return as-is, no mutation
      create: { id: clientId, userId, name, slackChannel, slackWebhook },
      select: { id: true },
    })
    console.log(`[projects] POST upsert id=${project.id.slice(0, 8)} ${existing ? 'IDEMPOTENT-HIT' : 'CREATE'} name="${name}" ms=${Date.now() - tStart}`)
    return NextResponse.json({ id: project.id }, { status: 201 })
  }

  const project = await prisma.project.create({
    data: { userId, name, slackChannel, slackWebhook },
    select: { id: true },
  })
  console.log(`[projects] POST legacy-create id=${project.id.slice(0, 8)} name="${name}" ms=${Date.now() - tStart}`)

  return NextResponse.json({ id: project.id }, { status: 201 })
}
