import { hash, compare } from 'bcryptjs'

const SALT_ROUNDS = 12

export async function hashPassword(password: string): Promise<string> {
  return hash(password, SALT_ROUNDS)
}

export async function verifyPassword(password: string, hashedPassword: string): Promise<boolean> {
  return compare(password, hashedPassword)
}

// Raised from 8 → 12 ahead of remote ("Phone access") exposure: behind a
// single login sits host RCE, so the password is the whole defense over a
// public tunnel. 12 chars + character-class + a small common-password
// reject is a meaningful brute-force/credential-stuffing speed bump
// without pulling in an external breach-list dependency.
const MIN_LENGTH = 12
const MAX_LENGTH = 128

// Lowercased substrings that, if a password is built mostly around them,
// make it trivially guessable. Not a breach database — just the worst
// offenders that pass the character-class checks (e.g. "Password1").
const COMMON_PATTERNS = [
  'password', 'passw0rd', 'qwerty', 'asdf', 'letmein', 'admin', 'welcome',
  'iloveyou', 'monkey', 'dragon', 'abc123', '123456', '12345678', '111111',
  'changeme', 'change-me', 'noztos', 'bornastar', 'secret',
]

export function validatePassword(password: string): string | null {
  if (!password || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters`
  }
  if (password.length > MAX_LENGTH) {
    return `Password must be at most ${MAX_LENGTH} characters`
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter'
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter'
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number'
  }
  const lower = password.toLowerCase()
  if (COMMON_PATTERNS.some((p) => lower.includes(p))) {
    return 'Password is too common or contains an easily guessed word'
  }
  return null
}
