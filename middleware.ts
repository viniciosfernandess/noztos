import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/login', '/register', '/reset-password', '/api/auth/', '/api/companion/', '/admin/login', '/api/admin/login']

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p))
}

export function middleware(request: NextRequest) {
  const { pathname, host } = request.nextUrl

  // Canonicalise to the apex (no-www) host. Anyone landing on
  // www.noztos.com gets a 308 to the same path on noztos.com so SEO,
  // cookies, and GitHub OAuth callbacks all see a single canonical
  // origin. Skip the redirect in local dev (host is `localhost:3000`
  // or similar) so the loopback flow still works.
  if (host.startsWith('www.')) {
    const url = request.nextUrl.clone()
    url.host = host.slice(4)
    return NextResponse.redirect(url, 308)
  }

  // Allow static assets, Next.js internals, and public routes
  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.includes('.') ||
    isPublic(pathname)
  ) {
    return NextResponse.next()
  }

  // /admin/* (other than /admin/login which is public above) requires
  // the separate admin-session cookie. The regular user `session`
  // cookie is NOT accepted here — operator access is a parallel auth
  // system. Bounce missing/invalid admin cookies to /admin/login.
  if (pathname.startsWith('/admin') || pathname.startsWith('/api/admin')) {
    const adminCookie = request.cookies.get('admin-session')?.value
    if (!adminCookie || !adminCookie.includes('|')) {
      const loginUrl = new URL('/admin/login', request.url)
      return NextResponse.redirect(loginUrl)
    }
    return NextResponse.next()
  }

  // Check for session cookie presence. The format is "userId|hmac".
  // Full HMAC verification happens server-side in lib/session.ts.
  const sessionValue = request.cookies.get('session')?.value
  if (!sessionValue || !sessionValue.includes('|')) {
    // Self-hosted OSS: any unauthenticated visit goes to /login. The
    // marketing landing page lives at noztos.com (a separate static
    // deploy) — running locally, the user expects to log in.
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
