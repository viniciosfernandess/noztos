import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth, generateCompanionToken, listCompanionTokens, revokeCompanionToken } from '@/lib/auth'

// GET — List all companion tokens for the current user.
// Returns tokens with preview (bst_xxxx...yyyy) — never the full token.
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const tokens = await listCompanionTokens(auth.userId)
  return NextResponse.json({ tokens })
}

// POST — Generate a new companion token.
// Body: { name?: string } — optional label for the token.
// Returns the FULL token ONCE — user must copy it now.
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as { name?: string }
  const token = await generateCompanionToken(auth.userId, body.name ?? 'Default')

  return NextResponse.json({
    token,
    message: 'Token generated. Copy it now — it won\'t be shown again.',
    usage: `noztos login ${token}`,
  })
}

// DELETE — Revoke a companion token.
// Body: { tokenId: string }
export async function DELETE(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as { tokenId?: string }
  if (!body.tokenId) {
    return NextResponse.json({ error: 'tokenId required' }, { status: 400 })
  }

  const revoked = await revokeCompanionToken(body.tokenId, auth.userId)
  if (!revoked) {
    return NextResponse.json({ error: 'Token not found' }, { status: 404 })
  }

  return NextResponse.json({ ok: true })
}
