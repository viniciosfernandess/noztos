import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { loadProjectGitContext } from '@/lib/git'
import { prisma } from '@/lib/db'
import { cloudAwareCompute } from '@/lib/compute-router'

interface RouteContext { params: Promise<{ id: string }> }

// POST — publish a local-only project to a new GitHub repository.
//
// Body: { repoName: string; isPrivate?: boolean }
//
// Steps:
//   1. Create a new GitHub repo under the authenticated user's account.
//   2. Add it as `origin` on the local clone (replacing any existing remote).
//   3. Push all local branches.
//   4. Update the Repository row with the real githubOwner + githubRepo so
//      all subsequent operations (PR creation, refresh-main, etc.) go through
//      the normal GitHub-backed path.
export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  let body: { repoName?: string; isPrivate?: boolean } = {}
  try { body = await request.json() } catch {}

  const repoName = body.repoName?.trim()
  if (!repoName) return NextResponse.json({ error: 'repoName required' }, { status: 400 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })
  if (!ctx.githubToken) return NextResponse.json({ error: 'GitHub not connected — link your account first', code: 'no_auth' }, { status: 401 })

  // Step 1 — create repo on GitHub
  const createRes = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.githubToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({
      name: repoName,
      private: body.isPrivate ?? false,
      auto_init: false,
    }),
  })

  if (!createRes.ok) {
    const err = await createRes.json().catch(() => ({}))
    return NextResponse.json(
      { error: (err as { message?: string }).message ?? 'Failed to create GitHub repository' },
      { status: createRes.status },
    )
  }

  const repoData = await createRes.json() as { owner: { login: string }; name: string; html_url: string }
  const owner = repoData.owner.login
  const repo = repoData.name
  const remoteUrl = `https://${ctx.githubToken}@github.com/${owner}/${repo}.git`

  // Step 2+3 — wire up the remote and push. Publishing is always a
  // main-branch op so the cloud-aware router falls back to local
  // automatically.
  const compute = cloudAwareCompute

  await compute.exec(ctx.sandboxId, `cd ${ctx.sandboxId} && git remote remove origin 2>/dev/null || true`)
  await compute.exec(ctx.sandboxId, `cd ${ctx.sandboxId} && git remote add origin ${remoteUrl}`)

  const pushRes = await compute.exec(
    ctx.sandboxId,
    `cd ${ctx.sandboxId} && git push -u origin --all 2>&1`,
  )
  if (pushRes.exitCode !== 0) {
    return NextResponse.json({ error: pushRes.stderr || pushRes.stdout || 'push failed' }, { status: 500 })
  }

  // Step 4 — link the project to the new GitHub repo
  await prisma.repository.update({
    where: { projectId: id },
    data: { githubOwner: owner, githubRepo: repo },
  })

  return NextResponse.json({ ok: true, owner, repo, url: repoData.html_url })
}
