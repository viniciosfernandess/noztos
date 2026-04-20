import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { verifyProjectAccess } from '@/lib/auth'
import { syncRepoFiles } from '@/lib/github'

interface RouteParams {
  params: Promise<{ id: string }>
}

// POST — Connect a GitHub repo OR register a local path to this project
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const body = (await request.json()) as {
    owner?: string
    repo?: string
    branch?: string
    localPath?: string
  }

  // Local project — just register the path, no GitHub needed
  if (body.localPath) {
    const existing = await prisma.repository.findUnique({ where: { projectId: id } })
    if (existing) {
      return NextResponse.json({ error: 'Project already has a repository.' }, { status: 409 })
    }
    const repository = await prisma.repository.create({
      data: {
        projectId: id,
        githubOwner: '',
        githubRepo: '',
        githubBranch: 'main',
        sandboxId: body.localPath,
        sandboxStatus: 'running',
      },
    })
    return NextResponse.json({
      success: true,
      repositoryId: repository.id,
      localPath: body.localPath,
    }, { status: 201 })
  }

  // GitHub project — clone from remote
  const { owner, repo, branch } = body
  if (!owner || !repo) {
    return NextResponse.json({ error: 'owner and repo (or localPath) required' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: auth.userId },
    select: { githubToken: true },
  })

  if (!user?.githubToken) {
    return NextResponse.json({ error: 'GitHub not connected' }, { status: 400 })
  }

  // Check if project already has a repo
  const existing = await prisma.repository.findUnique({ where: { projectId: id } })
  if (existing) {
    return NextResponse.json({ error: 'Project already has a repository. Disconnect first.' }, { status: 409 })
  }

  // Create repository record
  const repository = await prisma.repository.create({
    data: {
      projectId: id,
      githubOwner: owner,
      githubRepo: repo,
      githubBranch: branch ?? 'main',
    },
  })

  // Sync files from GitHub
  try {
    console.log(`[repo-sync] Starting sync for ${owner}/${repo} (branch: ${branch ?? 'main'})`)
    const result = await syncRepoFiles(
      repository.id,
      user.githubToken,
      owner,
      repo,
      branch ?? 'main'
    )
    console.log(`[repo-sync] Done: ${result.fileCount} files, sha: ${result.commitSha}`)
    return NextResponse.json({
      success: true,
      repositoryId: repository.id,
      fileCount: result.fileCount,
      commitSha: result.commitSha,
    }, { status: 201 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed'
    console.error(`[repo-sync] ERROR:`, msg)
    // Cleanup if sync fails
    await prisma.repository.delete({ where: { id: repository.id } })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

// GET — Get repository info for this project
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const repository = await prisma.repository.findUnique({
    where: { projectId: id },
    select: {
      id: true,
      githubOwner: true,
      githubRepo: true,
      githubBranch: true,
      lastSyncedSha: true,
      lastSyncedAt: true,
      _count: { select: { files: true } },
    },
  })

  if (!repository) {
    return NextResponse.json({ connected: false })
  }

  const modifiedCount = await prisma.repoFile.count({
    where: { repositoryId: repository.id, isModified: true },
  })

  return NextResponse.json({
    connected: true,
    owner: repository.githubOwner,
    repo: repository.githubRepo,
    branch: repository.githubBranch,
    lastSyncedSha: repository.lastSyncedSha,
    lastSyncedAt: repository.lastSyncedAt,
    fileCount: repository._count.files,
    modifiedCount,
  })
}

// DELETE — Disconnect repo from project
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  const { id } = await params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  await prisma.repository.deleteMany({ where: { projectId: id } })
  return NextResponse.json({ success: true })
}
