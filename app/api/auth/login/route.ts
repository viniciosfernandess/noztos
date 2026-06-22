import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyPassword } from '@/lib/password'
import { setSessionCookieArgs, requestIsSecure, publicOriginUrl } from '@/lib/session'
import { clientIp, isLoginLocked, recordLoginFailure } from '@/lib/login-throttle'

// Parse credentials from either a JSON body (fetch-driven path from
// the React form) or a form-urlencoded body (native HTML form submit
// when JS hasn't hydrated — happens on Next.js dev mode over ngrok
// since hydration sometimes stalls behind the interstitial). Both
// paths reach the same auth logic; only the response shape differs.
async function readCreds(request: NextRequest): Promise<{ email?: string; password?: string; nativeForm: boolean }> {
  const contentType = request.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = await request.json().catch(() => ({})) as { email?: string; password?: string }
    return { email: body.email, password: body.password, nativeForm: false }
  }
  // Treat anything else as form-urlencoded (the HTML default).
  const text = await request.text()
  const params = new URLSearchParams(text)
  return {
    email: params.get('email') ?? undefined,
    password: params.get('password') ?? undefined,
    nativeForm: true,
  }
}

export async function POST(request: NextRequest) {
  try {
    const { email, password, nativeForm } = await readCreds(request)

    if (!email || !password) {
      return nativeForm
        ? NextResponse.redirect(publicOriginUrl(request, '/login?error=missing'), 303)
        : NextResponse.json({ error: 'Email and password are required' }, { status: 400 })
    }

    // Brute-force gate: refuse before touching the DB / bcrypt once this
    // IP or account has burned its failed-attempt budget. Key the account
    // axis on the normalized email (same as the DB lookup) so whitespace/
    // case variants can't mint fresh buckets.
    const ip = clientIp(request)
    const accountKey = email.toLowerCase().trim()
    if (isLoginLocked(ip, accountKey)) {
      return nativeForm
        ? NextResponse.redirect(publicOriginUrl(request, '/login?error=locked'), 303)
        : NextResponse.json(
            { error: 'Too many failed attempts. Try again later.' },
            { status: 429 },
          )
    }

    const user = await prisma.user.findUnique({
      where: { email: accountKey },
      select: { id: true, passwordHash: true },
    })

    if (!user) {
      recordLoginFailure(ip, accountKey)
      return nativeForm
        ? NextResponse.redirect(publicOriginUrl(request, '/login?error=invalid'), 303)
        : NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    const valid = await verifyPassword(password, user.passwordHash)
    if (!valid) {
      recordLoginFailure(ip, accountKey)
      return nativeForm
        ? NextResponse.redirect(publicOriginUrl(request, '/login?error=invalid'), 303)
        : NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
    }

    const sessionArgs = setSessionCookieArgs(user.id, requestIsSecure(request))
    if (nativeForm) {
      // Native HTML form submit — respond with a 303 to / so the
      // browser follows in one atomic op (cookie commits BEFORE the
      // follow-up GET). This is the no-JS fallback path.
      const response = NextResponse.redirect(publicOriginUrl(request, '/'), 303)
      response.cookies.set(sessionArgs)
      return response
    }
    // fetch-driven path: return JSON so the React handler can show
    // inline errors before triggering window.location.href.
    const response = NextResponse.json({ success: true })
    response.cookies.set(sessionArgs)
    return response
  } catch (err) {
    console.error('[login] failed:', err)
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 }
    )
  }
}
