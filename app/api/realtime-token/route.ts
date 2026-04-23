import { NextResponse } from 'next/server'
import { createHmac } from 'node:crypto'
import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'

// POST — Mint a short-lived JWT that a browser or mobile app can hand
// to supabase-js to open a Realtime subscription on chat_messages /
// chat_sessions.
//
// This is the "Caminho B" auth bridge: we keep our existing Bornastar
// session (cookie-based, managed in lib/session.ts and lib/auth.ts)
// and only *expose* the user id to Supabase through this signed,
// expiring claim. Supabase never sees our cookies, our password hashes,
// or any other auth state. If SUPABASE_JWT_SECRET leaks, rotating it
// invalidates every outstanding Realtime subscription — but nothing
// about our core login system.
//
// Security properties:
//   - JWT expires in 1 hour. Mobile clients refresh before expiry.
//   - `role: authenticated` is the Supabase convention that lets RLS
//     policies target `TO authenticated`. Our policies (see the
//     20260423000000 migration) check `userId = sub`, so even with a
//     stolen token a client can only subscribe to rows they own.
//   - No refresh_token is issued — the browser just hits this endpoint
//     again under its existing Bornastar cookie. That keeps refresh
//     authority entirely in our system, not Supabase's.
//
// Errors:
//   401 if no valid Bornastar session on the request.
//   500 if SUPABASE_JWT_SECRET is missing in env (misconfiguration).

const TOKEN_TTL_SECONDS = 60 * 60 // 1h

export async function POST() {
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const secret = process.env.SUPABASE_JWT_SECRET
  if (!secret) {
    console.error('[realtime-token] SUPABASE_JWT_SECRET is not set')
    return NextResponse.json({ error: 'Realtime not configured' }, { status: 500 })
  }

  const now = Math.floor(Date.now() / 1000)
  const token = signHs256Jwt(
    {
      sub: userId,
      role: 'authenticated',
      aud: 'authenticated',
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    },
    secret,
  )

  return NextResponse.json({
    token,
    expiresAt: (now + TOKEN_TTL_SECONDS) * 1000,
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? null,
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? null,
  })
}

// Minimal HS256 JWT signer — pulls no npm dep and matches the algorithm
// Supabase's Realtime server verifies against. The spec is small enough
// to do safely here; if we ever need ES256 / JWKS rotation we swap to
// `jose`.
function signHs256Jwt(payload: Record<string, unknown>, secret: string): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)))
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)))
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = createHmac('sha256', secret).update(signingInput).digest()
  return `${signingInput}.${base64url(signature)}`
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}
