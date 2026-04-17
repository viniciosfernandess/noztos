import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'

// ── Token prefix ────────────────────────────────────────────────────
// All companion tokens start with `bst_` so they're easy to identify
// in logs/config and never confused with session cookies.
const TOKEN_PREFIX = 'bst_'

/**
 * Generate a new companion token for a user.
 * Stored in DB, returned once to the user (they copy it to `bornastar login`).
 */
export async function generateCompanionToken(
  userId: string,
  name = 'Default',
): Promise<string> {
  const rawToken = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`

  await prisma.companionToken.create({
    data: {
      userId,
      token: rawToken,
      name,
    },
  })

  return rawToken
}

/**
 * Revoke (delete) a companion token.
 */
export async function revokeCompanionToken(tokenId: string, userId: string): Promise<boolean> {
  const result = await prisma.companionToken.deleteMany({
    where: { id: tokenId, userId },
  })
  return result.count > 0
}

/**
 * List all companion tokens for a user (without exposing the full token).
 */
export async function listCompanionTokens(userId: string) {
  const tokens = await prisma.companionToken.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      lastUsedAt: true,
      token: true,
    },
    orderBy: { createdAt: 'desc' },
  })
  return tokens.map((t) => ({
    id: t.id,
    name: t.name,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    tokenPreview: `${t.token.slice(0, 8)}...${t.token.slice(-4)}`,
  }))
}

/**
 * Verify the current request — supports BOTH authentication methods:
 *
 * 1. Cookie-based (browser): reads `session` cookie
 * 2. Bearer token (companion): reads `Authorization: Bearer bst_xxx`
 *    or `X-Companion-Token: bst_xxx` header
 *
 * Returns { userId } if valid, null if not.
 */
export async function verifyAuth(request?: NextRequest): Promise<{ userId: string } | null> {
  // Method 1: Bearer token / companion token header
  if (request) {
    const authHeader = request.headers.get('authorization')
    const companionHeader = request.headers.get('x-companion-token')
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : companionHeader

    if (bearerToken?.startsWith(TOKEN_PREFIX)) {
      const record = await prisma.companionToken.findUnique({
        where: { token: bearerToken },
        select: { id: true, userId: true, expiresAt: true },
      })
      if (!record) return null
      if (record.expiresAt && record.expiresAt < new Date()) return null

      // Update lastUsedAt (fire-and-forget, don't block the response)
      prisma.companionToken.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {})

      return { userId: record.userId }
    }
  }

  // Method 2: Cookie-based session (browser)
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)
  if (!userId) return null
  return { userId }
}

/**
 * Verifies the current session and project ownership.
 * Returns { userId, project } if valid, or { error, status } if not.
 */
export async function verifyProjectAccess(projectId: string) {
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  if (!userId) {
    return { error: 'Unauthorized', status: 401 as const }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  })

  if (!project || project.userId !== userId) {
    return { error: 'Not found', status: 404 as const }
  }

  return { userId, project }
}
