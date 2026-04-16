import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { findPullRequestForBranch, loadProjectGitContext } from '@/lib/git'

interface RouteContext { params: Promise<{ id: string; worktreeId: string }> }

// POST — convert the current draft PR for this worktree to "ready for
// review". GitHub's REST v3 API supports this by sending draft:false on
// PATCH /pulls/{n}, which is what we use here (falls back to a friendly
// error if the PR isn't actually a draft or already got marked ready).
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, worktreeId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const wt = await prisma.worktree.findUnique({
    where: { id: worktreeId },
    select: { projectId: true, branchName: true },
  })
  if (!wt || wt.projectId !== id) return NextResponse.json({ error: 'worktree not found' }, { status: 404 })

  const ctx = await loadProjectGitContext(id)
  if (!ctx) return NextResponse.json({ error: 'No repository' }, { status: 503 })
  if (!ctx.githubToken) return NextResponse.json({ error: 'GitHub not connected', code: 'no_auth' }, { status: 401 })

  const pr = await findPullRequestForBranch(ctx.githubOwner, ctx.githubRepo, wt.branchName, ctx.githubToken)
  if (!pr) return NextResponse.json({ error: 'no PR for this worktree' }, { status: 404 })
  if (!pr.draft) return NextResponse.json({ error: 'PR is not a draft' }, { status: 400 })

  // GraphQL mutation is the canonical path. REST PATCH with draft:false
  // doesn't work in all org setups, so we go through GraphQL.
  const gql = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.githubToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        query($owner:String!, $name:String!, $number:Int!){
          repository(owner:$owner, name:$name){ pullRequest(number:$number){ id } }
        }
      `,
      variables: { owner: ctx.githubOwner, name: ctx.githubRepo, number: pr.number },
    }),
  })
  const q = await gql.json().catch(() => ({}))
  const nodeId = q?.data?.repository?.pullRequest?.id
  if (!nodeId) return NextResponse.json({ error: 'could not resolve PR id' }, { status: 500 })

  const mut = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ctx.githubToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        mutation($id:ID!){
          markPullRequestReadyForReview(input:{ pullRequestId:$id }){
            pullRequest { id isDraft }
          }
        }
      `,
      variables: { id: nodeId },
    }),
  })
  const m = await mut.json().catch(() => ({}))
  if (m?.errors?.length) {
    return NextResponse.json({ error: m.errors[0]?.message ?? 'mark ready failed' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
