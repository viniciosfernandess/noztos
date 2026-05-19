import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashPassword, validatePassword } from '@/lib/password'
import { setSessionCookieArgs, requestIsSecure, publicOriginUrl } from '@/lib/session'

// Mirror of /api/auth/login: support both fetch-JSON and native HTML
// form posts so signup works even when React hasn't hydrated.
async function readBody(request: NextRequest) {
  const ct = request.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    const body = await request.json().catch(() => ({})) as {
      email?: string; password?: string; name?: string; company?: string; role?: string
    }
    return { ...body, nativeForm: false }
  }
  const text = await request.text()
  const p = new URLSearchParams(text)
  return {
    email: p.get('email') ?? undefined,
    password: p.get('password') ?? undefined,
    name: p.get('name') ?? undefined,
    company: p.get('company') ?? undefined,
    role: p.get('role') ?? undefined,
    nativeForm: true,
  }
}

export async function POST(request: NextRequest) {
  try {
    const { email, password, name, company, role, nativeForm } = await readBody(request)

    const errOut = (status: number, message: string, errorCode = 'invalid') =>
      nativeForm
        ? NextResponse.redirect(publicOriginUrl(request, `/login?mode=signup&error=${errorCode}`), 303)
        : NextResponse.json({ error: message }, { status })

    if (!email || !password || !name) {
      return errOut(400, 'Name, email, and password are required', 'missing')
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return errOut(400, 'Invalid email format', 'email')
    }

    const passwordError = validatePassword(password)
    if (passwordError) {
      return errOut(400, passwordError, 'password')
    }

    const existing = await prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
      select: { id: true },
    })
    if (existing) {
      return errOut(409, 'An account with this email already exists', 'taken')
    }

    const passwordHash = await hashPassword(password)
    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase().trim(),
        passwordHash,
        name: name.trim(),
        company: company?.trim() || null,
        role: role?.trim() || null,
      },
      select: { id: true },
    })

    const sessionArgs = setSessionCookieArgs(user.id, requestIsSecure(request))
    if (nativeForm) {
      const response = NextResponse.redirect(publicOriginUrl(request, '/'), 303)
      response.cookies.set(sessionArgs)
      return response
    }
    const response = NextResponse.json({ success: true }, { status: 201 })
    response.cookies.set(sessionArgs)
    return response
  } catch (err) {
    console.error('[register] failed:', err)
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    )
  }
}
