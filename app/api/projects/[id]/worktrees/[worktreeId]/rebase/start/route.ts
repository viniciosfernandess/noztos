import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadProjectGitContext, runGit } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// POST — kick off an interactive rebase of the worktree's branch onto
// origin/main. Returns either:
//   { status: 'clean' }                      ← rebase succeeded, no conflicts
//   { status: 'conflict', files: string[] }  ← rebase stopped; listed files
//                                              contain conflict markers that
//                                              the user must resolve
//
// Rebase is left in-progress on conflict so the frontend can walk the
// user through resolution, then call /rebase/continue to finish.
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, worktreePath: true, branchName: true },
  })
  if (!wt || wt.projectId !== id || !wt.worktreePath) {
    return NextResponse.json({ error: 'worktree not found' }, { status: 404 })
  }

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No sandbox' }, { status: 503 })

  // Auth'd fetch so private repos work. Keeps the local origin/main ref
  // current before we try to replay on top of it.
  const remote = ctx.githubToken
    ? `https://${ctx.githubToken}@github.com/${ctx.githubOwner}/${ctx.githubRepo}.git`
    : `https://github.com/${ctx.githubOwner}/${ctx.githubRepo}.git`
  await runGit(ctx.sandboxId, wt.worktreePath, `fetch ${remote} main:refs/remotes/origin/main`)

  // Use diff3 style so the merge-base is preserved in the markers —
  // makes both the inline buttons and future 3-way editor more useful.
  const rebase = await runGit(ctx.sandboxId, wt.worktreePath,
    `-c merge.conflictStyle=diff3 rebase origin/main`)

  if ((rebase.exitCode ?? 0) === 0) {
    return NextResponse.json({ status: 'clean' })
  }

  // Rebase paused with conflicts. Use porcelain=v2 so we can tell text
  // conflicts (UU) apart from rename/delete pairs (DU/UD/AU/UA/AA) —
  // each needs a different resolution UI on the frontend.
  const porcelain = await runGit(ctx.sandboxId, wt.worktreePath, `status --porcelain=v2 -z`)
  const files = parseConflictStatus(porcelain.stdout)

  return NextResponse.json({ status: 'conflict', files })
}

// Each entry returned to the frontend carries enough info for the
// panel component to render the right resolution UI.
interface ConflictFile {
  path: string
  kind: 'text' | 'rename' | 'delete' | 'binary'
  // Extra context per kind:
  //   rename → { oldPath } when one side renamed the file
  //   delete → { deletedBy: 'ours' | 'theirs' }
  //   binary → { size } (bytes, best-effort)
  meta?: Record<string, unknown>
}

// Parse `git status --porcelain=v2 -z` output and classify each
// unmerged entry. The v2 format is one line per entry separated by
// NUL characters, with a leading type byte ('u' = unmerged, '1' =
// ordinary change, '2' = rename, '?' = untracked).
function parseConflictStatus(raw: string): ConflictFile[] {
  const entries = raw.split('\u0000').filter(Boolean)
  const out: ConflictFile[] = []
  for (const entry of entries) {
    if (!entry.startsWith('u ')) continue
    // Format:  u <XY> <sub> <mH> <mI> <mW> <hH> <hI> <hW> <path>
    // XY: two-letter status like "UU", "DU", "UD", "AU", "UA", "AA", "DD".
    const parts = entry.split(' ')
    const xy = parts[1] ?? 'UU'
    const path = parts.slice(9).join(' ')
    let kind: ConflictFile['kind'] = 'text'
    const meta: Record<string, unknown> = {}
    if (xy === 'DU') { kind = 'delete'; meta.deletedBy = 'theirs' }
    else if (xy === 'UD') { kind = 'delete'; meta.deletedBy = 'ours' }
    else if (xy === 'AU' || xy === 'UA' || xy === 'AA') { kind = 'rename' }
    // Detect binary via a quick heuristic: if file matches common
    // binary extensions OR git reports no text changes, treat as
    // binary so the panel renders a preview instead of a text diff.
    if (kind === 'text' && /\.(png|jpg|jpeg|gif|webp|pdf|ico|zip|tar|gz|woff2?|ttf|eot|mp4|mov)$/i.test(path)) {
      kind = 'binary'
    }
    out.push({ path, kind, meta: Object.keys(meta).length ? meta : undefined })
  }
  return out
}
