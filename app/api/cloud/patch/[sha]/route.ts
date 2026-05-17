// GET /api/cloud/patch/[sha]
//
// Serves the decrypted git-format-patch bytes for one UnpushedCommit.
// Sandbox calls this for each commit in the materialize manifest's
// unpushedCommits[] list, then pipes the result through `git am`.
//
// Auth: sandbox bearer token. The commit must belong to the sandbox's
// worktree; otherwise 403.

import { NextRequest, NextResponse } from 'next/server'
import { verifySandboxAuth } from '@/lib/mirror/sandbox-auth'
import { prisma } from '@/lib/db'
import { decryptAndDecompress } from '@/lib/mirror/crypto'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sha: string }> },
) {
  const auth = await verifySandboxAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { sha } = await params
  if (!sha || typeof sha !== 'string') {
    return NextResponse.json({ error: 'sha required' }, { status: 400 })
  }

  const row = await prisma.unpushedCommit.findUnique({
    where: { worktreeId_commitSha: { worktreeId: auth.worktreeId, commitSha: sha } },
  })
  if (!row) {
    return NextResponse.json({ error: 'patch not found' }, { status: 404 })
  }

  const plaintext = await decryptAndDecompress(Buffer.from(row.patchContent), auth.userId)
  return new NextResponse(new Uint8Array(plaintext), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(plaintext.length),
      'Cache-Control': 'no-store',
    },
  })
}
