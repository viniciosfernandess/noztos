import { describe, it, expect } from 'vitest'
import { validatePassword } from '../lib/password'

describe('lib/password validatePassword', () => {
  it('accepts a strong 12+ char password', () => {
    expect(validatePassword('Tr0ubled-Quokka')).toBeNull()
  })

  it('rejects passwords shorter than 12 chars (raised from 8)', () => {
    // Was valid under the old 8-char policy.
    expect(validatePassword('Abcdef1g')).toMatch(/at least 12/)
  })

  it('still enforces character classes', () => {
    expect(validatePassword('alllowercase1')).toMatch(/uppercase/)
    expect(validatePassword('ALLUPPERCASE1')).toMatch(/lowercase/)
    expect(validatePassword('NoNumbersHere')).toMatch(/number/)
  })

  it('rejects common / guessable passwords even when they pass classes', () => {
    expect(validatePassword('Password1234')).toMatch(/too common/)
    expect(validatePassword('Welcome12345')).toMatch(/too common/)
    expect(validatePassword('Change-Me123')).toMatch(/too common/)
  })

  it('rejects over-long passwords', () => {
    expect(validatePassword('A1' + 'a'.repeat(200))).toMatch(/at most/)
  })
})
