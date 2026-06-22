// ── Login brute-force throttle ──────────────────────────────────────
//
// Thin wrapper over lib/rate-limit.ts dedicated to the pre-auth surfaces
// (/api/auth/login, /api/admin/login, /api/auth/forgot-password). These
// are the only routes reachable with zero credentials over the public
// "Phone access" tunnel, so they're the brute-force / credential-stuffing
// / email-enumeration front door.
//
// Design: token-bucket per key. For credential checks we only consume a
// token on a FAILED attempt and check (without consuming) before doing
// the bcrypt compare — so a legitimate user who types the right password
// is never locked out, while an attacker grinding guesses is throttled on
// two independent axes:
//   - per IP      → one host can't hammer many accounts
//   - per account → a botnet can't hammer one account from many IPs
//
// In-process only (single-machine, local-first). Buckets are GC'd by the
// underlying rate-limit module.

import type { NextRequest } from 'next/server'
import { rateLimit } from './rate-limit'

const WINDOW_MS = 15 * 60_000 // 15 minutes

// Credential-check failure budgets.
const ipFailures = rateLimit({ tokensPerInterval: 10, intervalMs: WINDOW_MS }, 'auth-fail-ip')
const accountFailures = rateLimit({ tokensPerInterval: 5, intervalMs: WINDOW_MS }, 'auth-fail-account')

// Request budget for forgot-password (no "failure" concept — every call
// triggers a DB lookup + possible email send, so we limit per IP outright).
const forgotRequests = rateLimit({ tokensPerInterval: 5, intervalMs: 60 * 60_000 }, 'forgot-ip')

/** Best-effort client IP. Behind ngrok the real client is the first
 *  X-Forwarded-For hop; falls back to a constant so a spoofed/missing
 *  header still shares one bucket rather than escaping the limiter. */
export function clientIp(request: NextRequest): string {
  const fwd = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return fwd || request.headers.get('x-real-ip')?.trim() || 'unknown'
}

// The account axis is bucketed on a normalized key (trim + lowercase) so
// whitespace/case variants of the same identifier can't mint fresh
// buckets. Normalization lives HERE so every caller (user login, admin
// login) is consistent — callers pass the raw identifier.
function accountKey(account: string): string {
  return account.trim().toLowerCase()
}

/** True when the IP or account has spent its failed-attempt budget.
 *  Does NOT consume — call before verifying credentials. */
export function isLoginLocked(ip: string, account: string): boolean {
  return ipFailures.remaining(ip) < 1 || accountFailures.remaining(accountKey(account)) < 1
}

/** Record one failed credential attempt against both axes. */
export function recordLoginFailure(ip: string, account: string): void {
  ipFailures.take(ip)
  accountFailures.take(accountKey(account))
}

/** Consume one forgot-password request token for this IP. Returns false
 *  when the per-IP hourly budget is exhausted. */
export function takeForgotPasswordToken(ip: string): boolean {
  return forgotRequests.take(ip)
}
