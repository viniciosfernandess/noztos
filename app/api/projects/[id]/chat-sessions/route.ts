import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// ⚠️ MOCK MODE — temporary, for visual testing of long-name truncation in
// the sidebar. When true, overrides every chat session's name with a long
// fake. Set back to false to restore real names. Remove with the stats mock.
const MOCK_LONG_NAMES = true

// GET — list all open chat sessions for this project, including those that
// belong to a worktree (worktreeId is returned so the frontend can group them).
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const sessions = await prisma.chatSession.findMany({
    where: { projectId: id, status: 'open' },
    select: { id: true, name: true, worktreeId: true, createdAt: true, updatedAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // ⚠️ MOCK — override names with long fakes + cycle ages to test the
  // hover-only "last activity" badge format (now / Xm / Xh / Xd).
  if (MOCK_LONG_NAMES) {
    const fakeNames = [
      'Refactor the entire authentication system with OAuth2 and SAML SSO support',
      'Add a complete payment integration using Stripe with webhooks and refunds',
      'Migrate database from PostgreSQL to CockroachDB with zero downtime',
      'Build a real-time collaborative editor with operational transforms',
    ]
    const now = Date.now()
    const fakeAges = [
      0,                    // "now"
      2 * 60 * 60 * 1000,   // "2h"
      20 * 60 * 60 * 1000,  // "20h"
      1 * 24 * 60 * 60 * 1000,   // "1d"
      10 * 24 * 60 * 60 * 1000,  // "10d"
      100 * 24 * 60 * 60 * 1000, // "100d"
    ]
    return NextResponse.json({
      sessions: sessions.map((s, i) => ({
        ...s,
        name: fakeNames[i % fakeNames.length],
        updatedAt: new Date(now - fakeAges[i % fakeAges.length]).toISOString(),
      })),
    })
  }

  return NextResponse.json({ sessions })
}

// POST — create a new chat session.
//
// Body:
//   { worktreeId?: string }
//
// When worktreeId is provided, the chat lives inside that worktree's branch
// + working directory. When omitted, the chat operates on main directly.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: { worktreeId?: string; name?: string } = {}
  try { body = await request.json() } catch { /* empty body is fine */ }

  // Validate worktreeId if provided
  if (body.worktreeId) {
    const wt = await prisma.worktree.findUnique({
      where: { id: body.worktreeId },
      select: { projectId: true, status: true },
    })
    if (!wt || wt.projectId !== id || wt.status !== 'open') {
      return NextResponse.json({ error: 'Invalid worktree' }, { status: 400 })
    }
  }

  const session = await prisma.chatSession.create({
    data: {
      projectId: id,
      userId: access.userId,
      name: body.name?.trim() || 'New Chat',
      worktreeId: body.worktreeId ?? null,
    },
    select: { id: true, name: true, worktreeId: true, createdAt: true },
  })

  return NextResponse.json(session, { status: 201 })
}
