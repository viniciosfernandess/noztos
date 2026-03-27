import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

// POST — revert all modified files back to originalContent
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) return NextResponse.json({ error: access.error }, { status: access.status })

  const repo = await prisma.repository.findUnique({
    where: { projectId: id },
    select: { id: true },
  })
  if (!repo) return NextResponse.json({ error: 'No repository connected' }, { status: 404 })

  // Find all modified files
  const modifiedFiles = await prisma.repoFile.findMany({
    where: { repositoryId: repo.id, isModified: true },
    select: { id: true, originalContent: true },
  })

  // Revert each: files with empty originalContent (new files) get deleted, rest get reverted
  let reverted = 0
  let deleted = 0

  for (const file of modifiedFiles) {
    if (file.originalContent === '') {
      await prisma.repoFile.delete({ where: { id: file.id } })
      deleted++
    } else {
      await prisma.repoFile.update({
        where: { id: file.id },
        data: { content: file.originalContent, isModified: false },
      })
      reverted++
    }
  }

  return NextResponse.json({ reverted, deleted, total: reverted + deleted })
}
