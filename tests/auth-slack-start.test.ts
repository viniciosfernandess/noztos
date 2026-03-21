import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers
    _cookies: Map<string, { value: string; options: Record<string, unknown> }>

    constructor(body?: string, init?: { status?: number }) {
      this.status = init?.status ?? 200
      this.headers = new Headers()
      this._cookies = new Map()
    }

    static redirect(url: string | URL) {
      const res = new MockNextResponse(undefined, { status: 302 })
      res.headers.set('location', typeof url === 'string' ? url : url.toString())
      return res
    }

    get cookies() {
      const cookies = this._cookies
      return {
        set(name: string | Record<string, unknown>, value?: string, options?: Record<string, unknown>) {
          if (typeof name === 'string') {
            cookies.set(name, { value: value ?? '', options: options ?? {} })
          } else {
            cookies.set(name.name as string, { value: name.value as string, options: name })
          }
        },
        get(name: string) {
          return cookies.get(name)
        },
      }
    }
  }

  return { NextResponse: MockNextResponse }
})

describe('GET /api/auth/slack/start', () => {
  let originalClientId: string | undefined
  let originalRedirectUri: string | undefined

  beforeEach(() => {
    originalClientId = process.env.SLACK_CLIENT_ID
    originalRedirectUri = process.env.SLACK_REDIRECT_URI
    process.env.SLACK_CLIENT_ID = 'test-slack-client-id'
    process.env.SLACK_REDIRECT_URI = 'http://localhost:3000/api/auth/slack/callback'
  })

  afterEach(() => {
    if (originalClientId === undefined) delete process.env.SLACK_CLIENT_ID
    else process.env.SLACK_CLIENT_ID = originalClientId
    if (originalRedirectUri === undefined) delete process.env.SLACK_REDIRECT_URI
    else process.env.SLACK_REDIRECT_URI = originalRedirectUri
  })

  it('redirects to Slack authorization URL', async () => {
    const { GET } = await import('../app/api/auth/slack/start/route')
    const response = await GET() as unknown as { status: number; headers: Headers }

    expect(response.status).toBe(302)
    const location = response.headers.get('location')!
    const url = new URL(location)
    expect(url.hostname).toBe('slack.com')
    expect(url.pathname).toBe('/oauth/v2/authorize')
    expect(url.searchParams.get('client_id')).toBe('test-slack-client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/slack/callback')
  })

  it('sets auth_slack_state cookie with 64-char hex', async () => {
    const { GET } = await import('../app/api/auth/slack/start/route')
    const response = await GET() as unknown as { cookies: { get: (name: string) => { value: string } | undefined } }

    const stateCookie = response.cookies.get('auth_slack_state')
    expect(stateCookie).toBeDefined()
    expect(stateCookie!.value).toMatch(/^[0-9a-f]{64}$/)
  })

  it('includes state in both cookie and redirect URL', async () => {
    const { GET } = await import('../app/api/auth/slack/start/route')
    const response = await GET() as unknown as { headers: Headers; cookies: { get: (name: string) => { value: string } | undefined } }

    const stateCookie = response.cookies.get('auth_slack_state')!
    const location = response.headers.get('location')!
    const url = new URL(location)
    expect(url.searchParams.get('state')).toBe(stateCookie.value)
  })

  it('requests user_scope for user-level permissions', async () => {
    const { GET } = await import('../app/api/auth/slack/start/route')
    const response = await GET() as unknown as { headers: Headers }

    const location = response.headers.get('location')!
    const url = new URL(location)
    expect(url.searchParams.get('user_scope')).toContain('chat:write')
  })

  it('returns 500 when SLACK_CLIENT_ID is missing', async () => {
    delete process.env.SLACK_CLIENT_ID
    const { GET } = await import('../app/api/auth/slack/start/route')
    const response = await GET() as unknown as { status: number }

    expect(response.status).toBe(500)
  })
})
