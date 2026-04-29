import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'
import { broadcastCommandToAllCompanions } from '@/lib/companion-relay'
import { Prisma } from '@/generated/prisma/client'

// Admin endpoint — read or update the singleton companion_config row.
// Gated on ADMIN_USER_IDS env (same convention as /api/admin/metrics).
// Editing through this endpoint is what propagates new prompts to every
// online companion daemon: after the DB row is bumped, the broadcast
// helper enqueues a `config_updated` command on every active SSE
// channel, each daemon re-fetches /api/companion/config and replaces
// its in-memory active config — typically <1s end to end.

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

  const config = await prisma.companionConfig.findUnique({ where: { id: 'singleton' } })
  if (!config) return NextResponse.json({ error: 'No config row' }, { status: 404 })
  return NextResponse.json({
    modePrompts: config.modePrompts,
    namingRule: config.namingRule,
    disallowedTools: config.disallowedTools,
    version: config.version,
    updatedAt: config.updatedAt,
  })
}

interface UpdateBody {
  modePrompts?: { plan?: string; ask?: string; agent?: string }
  namingRule?: string
  disallowedTools?: { plan?: string[]; ask?: string[]; agent?: string[] }
  version: string
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

  // Version is mandatory — the daemons compare against it to detect
  // changes. Bumping it on every save is what makes polling reliable.
  if (typeof body.version !== 'string' || body.version.length === 0) {
    return NextResponse.json({ error: 'Missing version' }, { status: 400 })
  }

  // Merge with existing row so partial updates are possible (admin
  // doesn't have to repeat unchanged fields). The seed is always
  // there as the floor, so undefined fields fall through to it.
  const current = await prisma.companionConfig.findUnique({ where: { id: 'singleton' } })
  if (!current) return NextResponse.json({ error: 'No config row' }, { status: 404 })

  const merged: Prisma.CompanionConfigUpdateInput = {
    modePrompts: body.modePrompts
      ? { ...(current.modePrompts as Record<string, string>), ...body.modePrompts }
      : (current.modePrompts as Prisma.InputJsonValue),
    namingRule: body.namingRule ?? current.namingRule,
    disallowedTools: body.disallowedTools
      ? { ...(current.disallowedTools as Record<string, string[]>), ...body.disallowedTools }
      : (current.disallowedTools as Prisma.InputJsonValue),
    version: body.version,
  }

  const updated = await prisma.companionConfig.update({
    where: { id: 'singleton' },
    data: merged,
  })

  // Push the update to every connected companion. Disconnected ones
  // pick up via /config-version polling on next reconnect (or the
  // periodic 5-min poll inside an already-running daemon).
  const broadcastedTo = broadcastCommandToAllCompanions({ type: 'config_updated' })

  return NextResponse.json({
    ok: true,
    version: updated.version,
    broadcastedTo,
  })
}
