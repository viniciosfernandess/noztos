import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/login', '/register', '/docs', '/reset-password', '/api/auth/', '/api/companion/']

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

  // Check for session cookie presence. The format is "userId|hmac".
  // Full HMAC verification happens server-side in lib/session.ts.
  const sessionValue = request.cookies.get('session')?.value
  if (!sessionValue || !sessionValue.includes('|')) {
    // Unauthenticated root visit → serve the marketing landing page
    // (public/landing.html, a self-contained HTML/CSS/JS bundle from
    // the cloud-design export). URL stays as `/` (rewrite, not redirect)
    // so the canonical homepage matches the user's expectation.
    // Any other authenticated path still redirects to /login.
    if (pathname === '/') {
      return NextResponse.rewrite(new URL('/landing.html', request.url))
    }
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
