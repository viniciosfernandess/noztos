import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'u_test' }),
    },
  },
}))

function req(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const VALID = {
  email: 'new@example.com',
  password: 'Tr0ubled-Quokka',
  name: 'New User',
}

describe('POST /api/auth/register gate', () => {
  const env = { ...process.env }
  beforeEach(() => {
    process.env.NODE_SECRET = 'test-secret'
    delete process.env.ALLOW_OPEN_REGISTRATION
    delete process.env.REGISTRATION_INVITE_CODE
  })
  afterEach(() => {
    process.env = { ...env }
  })

  it('rejects registration when closed (default)', async () => {
    const { POST } = await import('../app/api/auth/register/route')
    const res = await POST(req(VALID))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: 'Registration is closed' })
  })

  it('allows registration when ALLOW_OPEN_REGISTRATION=true', async () => {
    process.env.ALLOW_OPEN_REGISTRATION = 'true'
    const { POST } = await import('../app/api/auth/register/route')
    const res = await POST(req(VALID))
    expect(res.status).toBe(201)
  })

  it('allows registration with a matching invite code', async () => {
    process.env.REGISTRATION_INVITE_CODE = 'let-me-in'
    const { POST } = await import('../app/api/auth/register/route')
    const res = await POST(req({ ...VALID, inviteCode: 'let-me-in' }))
    expect(res.status).toBe(201)
  })

  it('rejects a wrong invite code', async () => {
    process.env.REGISTRATION_INVITE_CODE = 'let-me-in'
    const { POST } = await import('../app/api/auth/register/route')
    const res = await POST(req({ ...VALID, inviteCode: 'nope' }))
    expect(res.status).toBe(403)
  })
})
