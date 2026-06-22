// POST /api/auth/forgot-password
//
// Body: { email: string }
//
// Behaviour:
//   - Always returns 200 with `{ ok: true }`, regardless of whether the
//     email exists. This prevents email enumeration: an attacker can't
//     probe valid accounts by watching the response.
//   - If the email matches a user, we generate a 32-byte random token,
//     store its SHA-256 hash in PasswordResetToken with a 1h expiry,
//     and email the user a one-time link.
//   - If the email doesn't match, we silently no-op (still 200).
//
// Rate limiting: not in this MVP. With cost-12 bcrypt + 1h token
// expiry + Resend's own per-API-key limits, abuse is impractical for
// the user counts we expect (<100). Re-evaluate when signups open.

import { NextRequest, NextResponse } from 'next/server'
import { createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import { sendPasswordResetEmail } from '@/lib/email'
import { clientIp, takeForgotPasswordToken } from '@/lib/login-throttle'

const TOKEN_TTL_MS = 60 * 60 * 1000 // 1h

export async function POST(request: NextRequest) {
  let body: { email?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  if (typeof body.email !== 'string' || !body.email.includes('@')) {
    return NextResponse.json({ error: 'Email required' }, { status: 400 })
  }

  // Per-IP rate cap so the public tunnel can't be used to enumerate
  // accounts or weaponise Resend for spam. Generic 429 (no enumeration
  // leak — same as the anti-enumeration 200 path otherwise).
  if (!takeForgotPasswordToken(clientIp(request))) {
    return NextResponse.json(
      { error: 'Too many requests. Try again later.' },
      { status: 429 },
    )
  }

  const email = body.email.toLowerCase().trim()

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true },
  })

  // Same response shape no matter what — anti-enumeration.
  if (!user) {
    // Token-grain sleep so the "user not found" path takes about as
    // long as the "user found + email send" path; an attacker can't
    // time-side-channel valid emails. ~250-350ms is a reasonable band.
    await new Promise((r) => setTimeout(r, 280))
    return NextResponse.json({ ok: true })
  }

  // Generate a high-entropy token. The raw bytes leave the server once
  // in the email link; only the hash lives in the DB.
  const raw = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(raw).digest('hex')
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null

  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      ipAddress: ip,
    },
  })

  const base = process.env.BORNASTAR_PUBLIC_URL ?? 'http://localhost:3000'
  const resetUrl = `${base}/reset-password?token=${encodeURIComponent(raw)}`

  await sendPasswordResetEmail({
    to: user.email,
    resetUrl,
    name: user.name,
  })

  return NextResponse.json({ ok: true })
}
