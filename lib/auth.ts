import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'

/**
 * Verify the current session. Returns { userId } if valid, null if not.
 * Used by companion endpoints that don't need project ownership.
 */
export async function verifyAuth(_request?: NextRequest): Promise<{ userId: string } | null> {
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
