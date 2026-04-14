import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { generateWorktreeCodename, provisionWorktree } from '@/lib/worktree'
import { loadProjectGitContext, PROJECT_ROOT, runGit } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string }> }

// POST — when the user is in a main chat and hits a protected-branch block,
// move that chat's work onto a fresh worktree / branch.
//
// Body: { sessionId: string; newBranchName?: string }
//
// Behaviour:
//   1. Stash uncommitted changes in main (if any).
//   2. Create a new worktree + branch off main's current HEAD (which already
//      includes any local-only commits the chat produced).
//   3. Inside the new worktree, pop the stash so dirty files land there.
//   4. Hard-reset main back to origin/main so the chat's local divergence
//      doesn't stay lying around on main.
//   5. Update the chat session's worktreeId → the chat now belongs to the
//      worktree and the next agent turn runs in that working dir.
//
// Designed to be idempotent on failure — if anything after stash succeeds
// but before we reset main, the worktree still holds the work, so nothing
// is lost. The main reset is the last destructive step.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { sessionId?: string; newBranchName?: string } = {}
  try { body = await request.json() } catch {}
  if (!body.sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 })

  const session = await prisma.chatSession.findUnique({
    where: { id: body.sessionId },
    select: { id: true, projectId: true, worktreeId: true },
  })
  if (!session || session.projectId !== id) return NextResponse.json({ error: 'chat not found' }, { status: 404 })
  if (session.worktreeId) return NextResponse.json({ error: 'chat already inside a worktree' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })

  // 1) Stash uncommitted changes in main if any. Tag with a marker message so
  // we can identify and pop specifically this stash, even if others existed.
  const stashMarker = `bornastar-move-${session.id}-${Date.now()}`
  const stashRes = await runGit(ctx.sandboxId, PROJECT_ROOT, `stash push -u -m '${stashMarker}'`)
  const stashed = /Saved working directory/i.test(stashRes.stdout + stashRes.stderr)

  // 2) Create the worktree. provisionWorktree branches from main HEAD, so
  // any local-only commits the chat made are already carried along.
  const codename = body.newBranchName
    ? { name: body.newBranchName, branchName: body.newBranchName.replace(/[^a-z0-9-]/gi, '-').toLowerCase() }
    : await generateWorktreeCodename(id)

  const placeholder = await prisma.worktree.create({
    data: {
      projectId: id,
      userId: auth.userId,
      name: codename.name,
      branchName: codename.branchName,
      worktreePath: '_pending_',
      baseCommit: '_pending_',
    },
    select: { id: true },
  })

  const info = await provisionWorktree(id, placeholder.id, codename.branchName)
  if (!info) {
    await prisma.worktree.delete({ where: { id: placeholder.id } })
    // Restore the stash since we aborted before consuming it.
    if (stashed) await runGit(ctx.sandboxId, PROJECT_ROOT, `stash pop --index`)
    return NextResponse.json({ error: 'Failed to create worktree' }, { status: 500 })
  }

  const worktree = await prisma.worktree.update({
    where: { id: placeholder.id },
    data: {
      worktreePath: info.worktreePath,
      baseCommit: info.baseCommit,
      portBase: info.portBase,
    },
    select: { id: true, worktreePath: true, branchName: true, name: true },
  })

  // 3) Apply the stash inside the new worktree so dirty files move over.
  if (stashed) {
    // Find the stash ref whose message contains our marker (latest wins).
    const listRes = await runGit(ctx.sandboxId, PROJECT_ROOT, `stash list --format='%gd %gs'`)
    const line = listRes.stdout.split('\n').find((l) => l.includes(stashMarker))
    const ref = line?.split(' ')[0] ?? 'stash@{0}'
    // `git stash show -p <ref> | git apply -` applies the patch into the
    // worktree without consuming the stash in case of failure.
    const apply = await runGit(ctx.sandboxId, worktree.worktreePath, `-c core.pager=cat stash show -p ${ref}`)
    if (apply.exitCode === 0 && apply.stdout.trim()) {
      // Pipe the diff into `git apply` via a temp file for reliability.
      const tmp = `/tmp/bornastar-stash-${session.id}.patch`
      // Write patch using printf (robust for multi-line content via base64).
      const b64 = Buffer.from(apply.stdout).toString('base64')
      await runGit(ctx.sandboxId, worktree.worktreePath, `-c init.defaultBranch=main init tmpignored 2>/dev/null ; echo ${b64} | base64 -d > ${tmp}`)
      await runGit(ctx.sandboxId, worktree.worktreePath, `apply --whitespace=nowarn ${tmp} 2>&1 || true`)
    }
    // Drop the stash — the work now lives in the worktree.
    await runGit(ctx.sandboxId, PROJECT_ROOT, `stash drop ${ref}`)
  }

  // 4) Reset main back to origin/main. Only safe once the work is on the
  // branch. Clean removes untracked files that weren't in the stash.
  await runGit(ctx.sandboxId, PROJECT_ROOT, `fetch origin main:refs/remotes/origin/main 2>&1 || true`)
  await runGit(ctx.sandboxId, PROJECT_ROOT, `reset --hard origin/main`)
  await runGit(ctx.sandboxId, PROJECT_ROOT, `clean -fd`)

  // 5) Move the chat into the new worktree.
  await prisma.chatSession.update({
    where: { id: session.id },
    data: { worktreeId: worktree.id },
  })

  return NextResponse.json({
    ok: true,
    worktree: { id: worktree.id, name: worktree.name, branchName: worktree.branchName },
  })
}
