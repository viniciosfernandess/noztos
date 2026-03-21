import { NextResponse } from 'next/server'
import { randomBytes } from 'crypto'

const STATE_COOKIE = 'auth_slack_state'
const STATE_TTL = 60 * 10 // 10 minutes
const SLACK_AUTH_URL = 'https://slack.com/oauth/v2/authorize'

export async function GET() {
  const clientId = process.env.SLACK_CLIENT_ID
  const redirectUri = process.env.SLACK_REDIRECT_URI

  if (!clientId || !redirectUri) {
    return new NextResponse('Slack OAuth not configured: missing SLACK_CLIENT_ID or SLACK_REDIRECT_URI', {
      status: 500,
    })
  }

  const state = randomBytes(32).toString('hex')

  const authUrl = new URL(SLACK_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri)
  authUrl.searchParams.set('scope', '')
  authUrl.searchParams.set('user_scope', 'chat:write,channels:read,users:read')
  authUrl.searchParams.set('state', state)

  const response = NextResponse.redirect(authUrl.toString())
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_TTL,
  })

  return response
}
