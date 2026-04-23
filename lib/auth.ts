import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'

// ── Token prefix ────────────────────────────────────────────────────
// All companion tokens start with `bst_` so they're easy to identify
// in logs/config and never confused with session cookies.
const TOKEN_PREFIX = 'bst_'

// ── In-memory auth cache ────────────────────────────────────────────
//
// Hot-path requests (every daemon heartbeat, every sync batch, every
// messages POST) end up revalidating the same token against the remote
// Supabase DB. That's a ~200ms round trip we can skip for the lifetime
// of a token. Cache entries live for TTL_MS and are pinned to
// globalThis so Next dev hot-reloads don't wipe them.

interface AuthCacheEntry {
  userId: string
  tokenId?: string
  tokenName?: string
  expiresAt: number
}

interface ProjectAccessCacheEntry {
  userId: string
  projectId: string
  expiresAt: number
}

const AUTH_TTL_MS = 5 * 60_000
const PROJECT_TTL_MS = 5 * 60_000

const globalForAuth = globalThis as unknown as {
  __bornastarTokenCache?: Map<string, AuthCacheEntry>
  __bornastarProjectCache?: Map<string, ProjectAccessCacheEntry>
}
const tokenCache: Map<string, AuthCacheEntry> =
  globalForAuth.__bornastarTokenCache ?? new Map<string, AuthCacheEntry>()
const projectCache: Map<string, ProjectAccessCacheEntry> =
  globalForAuth.__bornastarProjectCache ?? new Map<string, ProjectAccessCacheEntry>()
if (process.env.NODE_ENV !== 'production') {
  globalForAuth.__bornastarTokenCache = tokenCache
  globalForAuth.__bornastarProjectCache = projectCache
}

export function invalidateTokenCache(token?: string): void {
  if (token) tokenCache.delete(token)
  else tokenCache.clear()
}

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
export async function verifyAuth(request?: NextRequest): Promise<{ userId: string; tokenId?: string; tokenName?: string } | null> {
  // Method 1: Bearer token / companion token header
  if (request) {
    const authHeader = request.headers.get('authorization')
    const companionHeader = request.headers.get('x-companion-token')
    const bearerToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : companionHeader

    if (bearerToken?.startsWith(TOKEN_PREFIX)) {
      // Short-circuit via the in-memory cache — saves a cross-region
      // DB round trip per stream chunk / sync batch.
      const now = Date.now()
      const cached = tokenCache.get(bearerToken)
      if (cached && cached.expiresAt > now) {
        return { userId: cached.userId, tokenId: cached.tokenId, tokenName: cached.tokenName }
      }

      const record = await prisma.companionToken.findUnique({
        where: { token: bearerToken },
        select: { id: true, userId: true, name: true, expiresAt: true },
      })
      if (!record) { tokenCache.delete(bearerToken); return null }
      if (record.expiresAt && record.expiresAt < new Date()) {
        tokenCache.delete(bearerToken); return null
      }

      // Fire-and-forget lastUsedAt update. Opportunistic — we don't
      // refresh this per request if the cache is warm, so it falls
      // behind by up to TTL minutes; acceptable for a usage stamp.
      prisma.companionToken.update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {})

      tokenCache.set(bearerToken, {
        userId: record.userId,
        tokenId: record.id,
        tokenName: record.name,
        expiresAt: now + AUTH_TTL_MS,
      })
      return { userId: record.userId, tokenId: record.id, tokenName: record.name }
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

  // Cache the (user, project) membership — same polling loops that
  // hit verifyAuth repeatedly also hit this one, and the answer only
  // changes when the project is deleted or ownership moves (rare).
  const cacheKey = `${userId}:${projectId}`
  const now = Date.now()
  const cached = projectCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return { userId, project: { id: cached.projectId, userId } }
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, userId: true },
  })

  if (!project || project.userId !== userId) {
    projectCache.delete(cacheKey)
    return { error: 'Not found', status: 404 as const }
  }

  projectCache.set(cacheKey, {
    userId,
    projectId,
    expiresAt: now + PROJECT_TTL_MS,
  })
  return { userId, project }
}
