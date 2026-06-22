import { describe, it, expect } from 'vitest'
import {
  isLoginLocked,
  recordLoginFailure,
  takeForgotPasswordToken,
} from '../lib/login-throttle'

// The throttle buckets are process-global singletons, so each test uses
// unique IP/account keys to stay independent.

describe('lib/login-throttle', () => {
  it('does not lock a fresh IP/account', () => {
    expect(isLoginLocked('10.0.0.1', 'fresh@example.com')).toBe(false)
  })

  it('locks an account after its failed-attempt budget (5) is spent', () => {
    const ip = '10.0.0.2'
    const account = 'target@example.com'
    for (let i = 0; i < 5; i++) {
      expect(isLoginLocked(ip, account)).toBe(false)
      recordLoginFailure(ip, account)
    }
    expect(isLoginLocked(ip, account)).toBe(true)
  })

  it('locks by IP axis across many accounts (budget 10)', () => {
    const ip = '10.0.0.3'
    // 10 failures against distinct accounts — IP bucket drains, no single
    // account hits its own limit.
    for (let i = 0; i < 10; i++) {
      recordLoginFailure(ip, `acct-${i}@example.com`)
    }
    expect(isLoginLocked(ip, 'brand-new@example.com')).toBe(true)
  })

  it('account axis is case-insensitive', () => {
    const ip = '10.0.0.4'
    for (let i = 0; i < 5; i++) recordLoginFailure(ip, 'MixedCase@Example.com')
    expect(isLoginLocked('10.0.0.99', 'mixedcase@example.com')).toBe(true)
  })

  it('forgot-password is capped per IP (5/hr)', () => {
    const ip = '10.0.0.5'
    for (let i = 0; i < 5; i++) expect(takeForgotPasswordToken(ip)).toBe(true)
    expect(takeForgotPasswordToken(ip)).toBe(false)
  })
})
