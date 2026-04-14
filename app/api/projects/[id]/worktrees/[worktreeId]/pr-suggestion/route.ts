import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, resolveWorkingDir, runGit } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// GET — compute a suggested PR title + body based on what this branch
// actually changed vs origin/main. Cheap heuristic for now:
//   • title derived from the branch name (kebab → sentence case)
//   • body summarises file changes via shortstat + name-status
//
// The Checks panel hits this once when nothing has been typed yet; the
// draft editor still lets the user tweak everything before Create PR.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, branchName: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const cwd = await resolveWorkingDir(id, worktreeId)
  if (!cwd) return NextResponse.json({ error: 'no working dir' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'no sandbox' }, { status: 503 })

  // Title from branch name — replace dashes with spaces, capitalize first.
  const rawName = wt.branchName.replace(/^(feat|fix|chore|docs|refactor|style|test)\//, '')
  const title = rawName.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  // Body from shortstat + name-status against origin/main.
  let body = ''
  try {
    const stats = await runGit(ctx.sandboxId, cwd, `diff --shortstat origin/main`)
    const nameStatus = await runGit(ctx.sandboxId, cwd, `diff --name-status origin/main`)
    const commits = await runGit(ctx.sandboxId, cwd, `log origin/main..HEAD --pretty=format:'- %s' --no-merges`)

    const parts: string[] = []
    parts.push('## Summary')
    parts.push('')
    if (stats.stdout.trim()) parts.push(stats.stdout.trim())

    if (commits.stdout.trim()) {
      parts.push('')
      parts.push('## Commits')
      parts.push('')
      parts.push(commits.stdout.trim())
    }

    if (nameStatus.stdout.trim()) {
      parts.push('')
      parts.push('## Files changed')
      parts.push('')
      for (const line of nameStatus.stdout.trim().split('\n')) {
        // Prefix the mark (A/M/D) as an inline badge for readability.
        const m = line.match(/^([A-Z])\s+(.+)$/)
        if (!m) continue
        const kind = m[1] === 'A' ? 'added' : m[1] === 'D' ? 'removed' : 'modified'
        parts.push(`- \`${m[2]}\` — ${kind}`)
      }
    }

    body = parts.join('\n')
  } catch {}

  return NextResponse.json({ title, body })
}
