import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { encrypt } from '@/lib/crypto'
import { getSessionUserId } from '@/lib/session'

// Slack OAuth 2.0 callback.
//
// Requires an existing Anthropic session — Slack auth adds a token to the
// already-authenticated user rather than creating a new one.

const STATE_COOKIE = 'auth_slack_state'
const TOKEN_URL = 'https://slack.com/api/oauth.v2.access'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  if (error) {
    return NextResponse.redirect(new URL('/?slack_error=auth_failed', request.url))
  }

  if (!code) {
    return NextResponse.redirect(new URL('/?slack_error=missing_code', request.url))
  }

  // CSRF: validate state param
  const storedState = request.cookies.get(STATE_COOKIE)?.value
  if (!storedState || storedState !== state) {
    return NextResponse.redirect(new URL('/?slack_error=state_mismatch', request.url))
  }

  // Require existing session — user must have authenticated via Anthropic first
  const sessionValue = request.cookies.get('session')?.value
  const userId = getSessionUserId(sessionValue)
  if (!userId) {
    return NextResponse.redirect(new URL('/?slack_error=no_session', request.url))
  }

  try {
    const clientId = process.env.SLACK_CLIENT_ID!
    const clientSecret = process.env.SLACK_CLIENT_SECRET!
    const redirectUri = process.env.SLACK_REDIRECT_URI!

    // Exchange code for token
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    })
    const tokenData = await tokenRes.json()

    // Slack returns user tokens under authed_user.access_token
    const accessToken: string | undefined = tokenData.authed_user?.access_token
    if (!accessToken) {
      return NextResponse.redirect(new URL('/?slack_error=auth_failed', request.url))
    }

    // Update existing user with encrypted Slack token
    await prisma.user.update({
      where: { id: userId },
      data: { slackToken: encrypt(accessToken) },
    })

    // Clear state cookie and redirect home
    const response = NextResponse.redirect(new URL('/', request.url))
    response.cookies.set(STATE_COOKIE, '', { maxAge: 0, path: '/' })

    return response
  } catch {
    return NextResponse.redirect(new URL('/?slack_error=auth_failed', request.url))
  }
}
