// POST /api/auth/reset-password
//
// Body: { token: string, password: string }
//
// Validates the reset token and updates the user's password. The token
// passed in the URL is hashed and looked up against PasswordResetToken;
// one-shot semantics enforced by checking `usedAt` and stamping it on
// success.

import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { prisma } from '@/lib/db'
import { hashPassword, validatePassword } from '@/lib/password'
import { setSessionCookieArgs, requestIsSecure } from '@/lib/session'

export async function POST(request: NextRequest) {
  let body: { token?: unknown; password?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Bad JSON' }, { status: 400 })
  }
  if (typeof body.token !== 'string' || typeof body.password !== 'string') {
    return NextResponse.json({ error: 'Token and password required' }, { status: 400 })
  }

  const pwErr = validatePassword(body.password)
  if (pwErr) {
    return NextResponse.json({ error: pwErr }, { status: 400 })
  }

  const tokenHash = createHash('sha256').update(body.token).digest('hex')
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  })

  if (!row) {
    return NextResponse.json({ error: 'Invalid or expired link.' }, { status: 400 })
  }
  if (row.usedAt) {
    return NextResponse.json({ error: 'This link has already been used.' }, { status: 400 })
  }
  if (row.expiresAt < new Date()) {
    return NextResponse.json({ error: 'This link has expired. Request a new one.' }, { status: 400 })
  }

  const newHash = await hashPassword(body.password)

  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash: newHash },
    }),
    prisma.passwordResetToken.update({
      where: { id: row.id },
      data: { usedAt: new Date() },
    }),
    // Invalidate every OTHER pending reset token for this user. A user
    // who clicked "forgot password" twice (or whose mailbox got
    // compromised) shouldn't have a second valid link sitting around.
    prisma.passwordResetToken.updateMany({
      where: {
        userId: row.userId,
        usedAt: null,
        id: { not: row.id },
      },
      data: { usedAt: new Date() },
    }),
  ])

  // Sign the user in directly so they don't have to type the password
  // they just set. Convenience that matches what Apple / GitHub do.
  const response = NextResponse.json({ ok: true })
  response.cookies.set(setSessionCookieArgs(row.userId, requestIsSecure(request)))
  return response
}
