// GET /api/cloud/blob/[hash]
//
// Serves a single decrypted blob to the authenticated sandbox.
// Stream is raw bytes — sandbox writes directly to disk. Patches
// (UnpushedCommit.patchContent) are served by the /api/cloud/patch/[sha]
// endpoint, not here.
//
// Verification chain on every read:
//   1. Sandbox auth → userId + worktreeId
//   2. Blob (userId, hash) exists → decrypt with that user's DEK
//   3. Recompute SHA-256 on plaintext → must match :hash
//      (catches tampering or storage corruption before bytes leave us)
//
// The /api/cloud/patch/[sha]/route.ts mirror endpoint is structurally
// identical for the UnpushedCommit case; keeping them separate makes
// auth scoping obvious in the URL.

import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { verifySandboxAuth } from '@/lib/mirror/sandbox-auth'
import { prisma } from '@/lib/db'
import { decryptAndDecompress } from '@/lib/mirror/crypto'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hash: string }> },
) {
  const auth = await verifySandboxAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { hash } = await params
  if (!hash || typeof hash !== 'string') {
    return NextResponse.json({ error: 'hash required' }, { status: 400 })
  }

  // Authorization: the blob must be referenced by SOME file entry in
  // this sandbox's worktree. Otherwise the sandbox is asking for a
  // blob it shouldn't know about (could be a cross-worktree probe).
  const entry = await prisma.worktreeFileEntry.findFirst({
    where: { worktreeId: auth.worktreeId, hash },
    select: { id: true },
  })
  if (!entry) {
    return NextResponse.json({ error: 'blob not referenced by this worktree' }, { status: 403 })
  }

  const blob = await prisma.gitObject.findUnique({
    where: { userId_hash: { userId: auth.userId, hash } },
  })
  if (!blob) {
    return NextResponse.json({ error: 'blob not found' }, { status: 404 })
  }

  const plaintext = await decryptAndDecompress(Buffer.from(blob.content), auth.userId)
  // Integrity check — if storage corruption flipped a bit, fail loud
  // rather than serve corrupted bytes that would silently break the
  // sandbox FS.
  const computed = createHash('sha256').update(plaintext).digest('hex')
  if (computed !== hash) {
    console.error(`[cloud/blob] hash mismatch user=${auth.userId} claimed=${hash} computed=${computed}`)
    return NextResponse.json({ error: 'blob integrity check failed' }, { status: 500 })
  }

  return new NextResponse(new Uint8Array(plaintext), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(plaintext.length),
      'Cache-Control': 'no-store',
    },
  })
}
