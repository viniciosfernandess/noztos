import { createHmac, timingSafeEqual } from 'crypto'

// HMAC-SHA256 signed session cookie.
//
// Format: "<userId>|<hmacHex>"
//
// We use HMAC (not AES) because userId is not sensitive — we just need to
// verify it wasn't tampered with. No decrypt step needed.
//
// NODE_SECRET must be set in the environment.

const COOKIE_NAME = 'session'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30 // 30 days

function getSecret(): string {
  const secret = process.env.NODE_SECRET
  if (!secret) {
    throw new Error(
      'NODE_SECRET environment variable is not set. ' +
        'Set it in .env.local or your hosting environment.'
    )
  }
  return secret
}

function sign(userId: string): string {
  return createHmac('sha256', getSecret()).update(userId).digest('hex')
}

/**
 * Given a cookie value, returns the userId if the HMAC is valid, or null if
 * the value is missing, malformed, or tampered.
 */
export function getSessionUserId(cookieValue: string | undefined): string | null {
  if (!cookieValue) return null

  const sep = cookieValue.lastIndexOf('|')
  if (sep === -1) return null

  const userId = cookieValue.slice(0, sep)
  const hmac = cookieValue.slice(sep + 1)
  const expected = sign(userId)

  try {
    const hmacBuf = Buffer.from(hmac, 'hex')
    const expectedBuf = Buffer.from(expected, 'hex')
    if (hmacBuf.length !== expectedBuf.length) return null
    return timingSafeEqual(hmacBuf, expectedBuf) ? userId : null
  } catch {
    return null
  }
}

/**
 * Returns the cookie arguments for setting a session cookie.
 * Pass the result directly to response.cookies.set().
 */
export function setSessionCookieArgs(userId: string, secure = false) {
  return {
    name: COOKIE_NAME,
    value: `${userId}|${sign(userId)}`,
    httpOnly: true,
    // `secure` must match the request's protocol:
    //   • HTTPS (cloudflared tunnel for phone access): secure=true so
    //     Safari iOS / strict browsers don't drop the cookie under ITP.
    //   • HTTP (Mac localhost dev): secure=false because some clients
    //     (curl, Chrome anonymous, third-party browsers) refuse to
    //     STORE Secure cookies received over plain HTTP — even with
    //     the documented "localhost exception", behaviour is patchy.
    // Caller (the route) passes the correct value by inspecting
    // request.nextUrl.protocol or the X-Forwarded-Proto header.
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: COOKIE_MAX_AGE,
  }
}

/**
 * True when the request reached us over HTTPS — either directly OR
 * through a reverse proxy (cloudflared, nginx, etc) that set the
 * X-Forwarded-Proto header. Used to decide whether to flip the
 * `Secure` flag on session cookies.
 */
export function requestIsSecure(request: { headers: Headers; nextUrl?: { protocol?: string } }): boolean {
  const forwarded = request.headers.get('x-forwarded-proto')
  if (forwarded === 'https') return true
  if (forwarded === 'http') return false
  return request.nextUrl?.protocol === 'https:'
}

/**
 * Build a URL on the **external** origin the client used, honouring
 * X-Forwarded-Host / X-Forwarded-Proto. `request.url` in Next.js
 * reports the internal localhost address even when the user reached
 * us through ngrok / cloudflared, so server-side redirects must NOT
 * derive from it — the browser would otherwise be told to navigate
 * to localhost (unreachable from a phone).
 */
export function publicOriginUrl(request: { headers: Headers; nextUrl: { protocol: string; host: string } }, path = '/'): URL {
  const forwardedHost = request.headers.get('x-forwarded-host') || request.headers.get('host')
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const host = forwardedHost ?? request.nextUrl.host
  const proto = forwardedProto ?? request.nextUrl.protocol.replace(':', '')
  return new URL(path, `${proto}://${host}`)
}

/**
 * Returns the cookie arguments for clearing the session cookie.
 */
export function clearSessionCookieArgs(secure = false) {
  return {
    name: COOKIE_NAME,
    value: '',
    httpOnly: true,
    // Mirror setSessionCookieArgs — see comment there.
    secure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: 0,
  }
}

export { COOKIE_NAME }
