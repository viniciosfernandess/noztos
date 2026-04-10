import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { provisionWorktree, generateWorktreeCodename } from '@/lib/worktree'

// ⚠️ MOCK MODE — temporary, for visual testing of long-name truncation.
// Remove with the chat-sessions stats and chat-sessions list mocks.
const MOCK_LONG_NAMES = true

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — list all open worktrees for this project, with their nested chats.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const worktrees = await prisma.worktree.findMany({
    where: { projectId: id, status: 'open' },
    select: {
      id: true,
      name: true,
      branchName: true,
      portBase: true,
      createdAt: true,
      updatedAt: true,
      sessions: {
        where: { status: 'open' },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  // ⚠️ MOCK — override worktree names with long fakes + cycle ages
  if (MOCK_LONG_NAMES) {
    const fakes = [
      'Build the brand new dashboard with charts and analytics',
      'Implement push notifications across iOS Android and web',
      'Add multi tenant support with org-level permissions and billing',
    ]
    const now = Date.now()
    const fakeAges = [
      30 * 60 * 1000,             // "30m"
      5 * 60 * 60 * 1000,         // "5h"
      3 * 24 * 60 * 60 * 1000,    // "3d"
    ]
    return NextResponse.json({
      worktrees: worktrees.map((w, i) => ({
        ...w,
        name: fakes[i % fakes.length],
        updatedAt: new Date(now - fakeAges[i % fakeAges.length]).toISOString(),
      })),
    })
  }

  return NextResponse.json({ worktrees })
}

// POST — create a new worktree (and provision its branch + working dir).
//
// Body: { name?: string }   ← optional override; otherwise we auto-generate
//                              a city codename like "Kampala v1" with branch
//                              `kampala-v1`.
//
// Also creates one default chat session inside the new worktree so the user
// can start working immediately. The provisioning runs synchronously so the
// caller knows whether it succeeded.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  let body: { name?: string } = {}
  try { body = await request.json() } catch { /* empty body is fine */ }

  // Generate a fresh codename (or honor the user-provided name as the display).
  const codename = await generateWorktreeCodename(id)
  const displayName = body.name?.trim() || codename.name

  // Create the row up-front with the real branchName so codename uniqueness
  // is enforced atomically — concurrent POSTs see each other's branchName.
  const placeholder = await prisma.worktree.create({
    data: {
      projectId: id,
      userId: access.userId,
      name: displayName,
      branchName: codename.branchName,
      worktreePath: '_pending_',
      baseCommit: '_pending_',
    },
    select: { id: true },
  })

  // Provision the on-disk worktree using the generated branchName
  const info = await provisionWorktree(id, placeholder.id, codename.branchName)
  if (!info) {
    // Rollback the placeholder if provisioning failed
    await prisma.worktree.delete({ where: { id: placeholder.id } })
    return NextResponse.json({ error: 'Failed to create worktree on sandbox' }, { status: 500 })
  }

  // Update with the real provisioning data
  const worktree = await prisma.worktree.update({
    where: { id: placeholder.id },
    data: {
      worktreePath: info.worktreePath,
      baseCommit: info.baseCommit,
      portBase: info.portBase,
    },
    select: {
      id: true,
      name: true,
      branchName: true,
      portBase: true,
      createdAt: true,
    },
  })

  // Auto-create the first chat inside this worktree
  const session = await prisma.chatSession.create({
    data: {
      projectId: id,
      userId: access.userId,
      name: 'New Chat',
      worktreeId: worktree.id,
    },
    select: { id: true, name: true, worktreeId: true, createdAt: true },
  })

  return NextResponse.json({ worktree, session }, { status: 201 })
}
