import { NextRequest, NextResponse } from 'next/server'

const PUBLIC_PATHS = ['/login', '/register', '/api/auth/']

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname.startsWith(p))
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

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
    const loginUrl = new URL('/login', request.url)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
