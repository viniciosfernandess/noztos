import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

// Exercise the real /api/auth/login handler end-to-end with the throttle
// wired in. User lookup is mocked to "not found" so every attempt is a
// failed credential check.
vi.mock('@/lib/db', () => ({
  prisma: { user: { findUnique: vi.fn().mockResolvedValue(null) } },
}))

function loginReq(email: string, ip: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password: 'whatever-wrong' }),
  })
}

describe('POST /api/auth/login brute-force lockout', () => {
  it('returns 401 for first failures then 429 once the account budget is spent', async () => {
    const { POST } = await import('../app/api/auth/login/route')
    const email = 'victim@example.com'
    const ip = '203.0.113.7' // unique to this test

    const codes: number[] = []
    for (let i = 0; i < 7; i++) {
      const res = await POST(loginReq(email, ip))
      codes.push(res.status)
    }

    // First 5 attempts are processed (401 invalid); after the budget is
    // spent the gate short-circuits to 429 before bcrypt.
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(codes.slice(5)).toEqual([429, 429])
  })
})
