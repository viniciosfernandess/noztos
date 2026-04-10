import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { E2BProvider } from '@/lib/compute-e2b'

const compute = new E2BProvider()

interface RouteContext {
  params: Promise<{ id: string }>
}

const PROJECT_ROOT = '/home/user/project'

// GET — diff stats per main chat session in one round trip.
// Returns { [sessionId]: { added, removed, files } }.
//
// Only main chats (worktreeId = null) get stats here. Worktree chats are
// covered by the worktree-level /worktrees/stats endpoint.
//
// For each main chat we run `git diff --shortstat origin/main -- <touchedPaths>`
// at the project root, scoped to only the files that chat touched. This
// represents "work this chat did that hasn't reached the GitHub main yet" —
// committed-but-not-pushed and uncommitted both count, push clears it.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }

  // Only main chats — worktree chats use the worktree-level endpoint
  const sessions = await prisma.chatSession.findMany({
    where: { projectId: id, status: 'open', worktreeId: null },
    select: { id: true, touchedPaths: true },
  })

  // Skip sessions with no touched paths — their badge is empty
  const sessionsWithPaths = sessions.filter((s) => s.touchedPaths.length > 0)
  if (sessionsWithPaths.length === 0) {
    return NextResponse.json(Object.fromEntries(sessions.map((s) => [s.id, { added: 0, removed: 0, files: 0 }])))
  }

  const sandboxId = await ensureSandboxRunning(id)
  if (!sandboxId) {
    return NextResponse.json(Object.fromEntries(sessions.map((s) => [s.id, { added: 0, removed: 0, files: 0 }])))
  }

  // Detect which ref to diff against: prefer origin/main, fall back to HEAD
  // (covers fresh repos that haven't been pushed yet, or repos with no remote).
  const refCheck = await compute.exec(
    sandboxId,
    `cd ${PROJECT_ROOT} && git rev-parse --verify origin/main 2>/dev/null && echo OK || echo MISSING`,
  )
  const ref = refCheck.stdout?.trim().endsWith('OK') ? 'origin/main' : 'HEAD'

  // Build one big shell command that emits stats for every session in one
  // round trip — keeps the polling cheap regardless of session count.
  const blocks = sessionsWithPaths.map((s) => {
    // Quote each path defensively
    const quotedPaths = s.touchedPaths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ')
    return `echo '---${s.id}---'; cd ${PROJECT_ROOT} && git diff --shortstat ${ref} -- ${quotedPaths} 2>/dev/null`
  }).join(' ; ')

  let combined = ''
  try {
    const res = await compute.exec(sandboxId, blocks)
    combined = res.stdout ?? ''
  } catch {
    // fall through to empty stats
  }

  // Parse the combined output, splitting by the per-session marker
  const stats: Record<string, { added: number; removed: number; files: number }> = {}
  for (const s of sessions) stats[s.id] = { added: 0, removed: 0, files: 0 }

  const parts = combined.split(/---([\w]+)---/g).filter(Boolean)
  for (let i = 0; i < parts.length; i += 2) {
    const sessionId = parts[i]
    const block = parts[i + 1] ?? ''
    if (!sessionId || !(sessionId in stats)) continue
    stats[sessionId] = parseShortstat(block.trim())
  }

  return NextResponse.json(stats)
}

// Parse `git diff --shortstat` output:
//   "  3 files changed, 42 insertions(+), 7 deletions(-)"
function parseShortstat(text: string): { added: number; removed: number; files: number } {
  if (!text) return { added: 0, removed: 0, files: 0 }
  const filesMatch = text.match(/(\d+) files? changed/)
  const addedMatch = text.match(/(\d+) insertions?\(\+\)/)
  const removedMatch = text.match(/(\d+) deletions?\(-\)/)
  return {
    files: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    added: addedMatch ? parseInt(addedMatch[1], 10) : 0,
    removed: removedMatch ? parseInt(removedMatch[1], 10) : 0,
  }
}
