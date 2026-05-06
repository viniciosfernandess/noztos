import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'
import { broadcastCommandToAllCompanions } from '@/lib/companion-relay'
import { invalidateSkillCache } from '@/lib/prompts'

// Admin endpoint — read or update platform-default agent skill prompts
// (CEO, Architect, Tester, Builder…). Mirrors /api/admin/companion-config
// exactly, but operates on Collaborator rows instead of the singleton
// companion_config row.
//
// Editing through this endpoint propagates new skill prompts to every
// online companion daemon: after the DB row is updated, we drop the
// server-side skill cache (so getSkillPrompt re-pulls fresh) and
// broadcast a 'skills_updated' command on every active SSE channel.
// Each daemon re-fetches /api/companion/skills and replaces its
// in-memory active skills — typically <1s end to end.
//
// Gated on ADMIN_USER_IDS env (same convention as companion-config).
async function requireAdmin(): Promise<{ userId: string } | NextResponse> {
  const cookieStore = await cookies()
  const userId = getSessionUserId(cookieStore.get('session')?.value)
  const admins = (process.env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!userId || admins.length === 0 || !admins.includes(userId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return { userId }
}

export async function GET() {
  const auth = await requireAdmin()
  if (auth instanceof NextResponse) return auth

  const skills = await prisma.collaborator.findMany({
    where: { isPlatformDefault: true, projectId: null },
    select: { id: true, name: true, description: true, skillMd: true, isActive: true, createdAt: true },
    orderBy: { name: 'asc' },
  })
  return NextResponse.json({ skills })
}

interface UpdateBody {
  // Agent name (case-insensitive, e.g. 'CEO', 'tester'). Required so
  // we know which Collaborator row to mutate.
  name: string
  // Optional partial fields. At least one of skillMd / description
  // must be present.
  skillMd?: string
  description?: string
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth instanceof NextResponse) return auth

  let body: UpdateBody
  try {
    body = await request.json() as UpdateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (typeof body.name !== 'string' || body.name.length === 0) {
    return NextResponse.json({ error: 'Missing name' }, { status: 400 })
  }
  if (body.skillMd === undefined && body.description === undefined) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  // Match by name within platform defaults — names are unique under the
  // (name, projectId) unique index when projectId is null.
  const target = await prisma.collaborator.findFirst({
    where: {
      name: { equals: body.name, mode: 'insensitive' },
      projectId: null,
      isPlatformDefault: true,
    },
    select: { id: true, name: true },
  })
  if (!target) {
    return NextResponse.json({ error: `Unknown platform default skill: ${body.name}` }, { status: 404 })
  }

  const data: { skillMd?: string; description?: string } = {}
  if (body.skillMd !== undefined) data.skillMd = body.skillMd
  if (body.description !== undefined) data.description = body.description

  await prisma.collaborator.update({
    where: { id: target.id },
    data,
  })

  // Drop the server-side cache for this skill so the next getSkillPrompt
  // call re-reads from the DB. Pass the canonical name (not the body
  // name, which may be different case) so the lowercase-keyed map hits.
  invalidateSkillCache(target.name)

  // Push to every connected companion daemon. Disconnected ones pick up
  // via /skills-version polling on next reconnect or the periodic 5-min
  // poll inside an already-running daemon.
  const broadcastedTo = broadcastCommandToAllCompanions({ type: 'skills_updated' })

  return NextResponse.json({
    ok: true,
    name: target.name,
    broadcastedTo,
  })
}
