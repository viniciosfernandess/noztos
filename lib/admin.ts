// Admin auth gate. The current MVP grants admin privileges to a fixed
// list of user IDs in the ADMIN_USER_IDS env var (comma-separated cuids).
// Pre-billing this is plenty — once we have a "team management" surface
// we promote a column on User (`role`) and read from there instead.

import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'

function adminIds(): Set<string> {
  const raw = process.env.ADMIN_USER_IDS ?? ''
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
}

export async function requireAdmin(): Promise<{ userId: string } | null> {
  const cookieStore = await cookies()
  const userId = getSessionUserId(cookieStore.get('session')?.value)
  if (!userId) return null
  if (!adminIds().has(userId)) return null
  return { userId }
}
