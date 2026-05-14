import { notFound, redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { prisma } from '@/lib/db'
import { getSessionUserId } from '@/lib/session'
import { ProjectDashboardClient } from '@/components/ProjectDashboardClient'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectPage({ params }: PageProps) {
  const { id } = await params
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  if (!userId) redirect('/login')

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, userId: true },
  })

  if (!project || project.userId !== userId) notFound()

  const [teams, tasks] = await Promise.all([
    prisma.team.findMany({
      where: { projectId: id },
      select: { id: true, name: true, collaboratorOrder: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.task.findMany({
      where: { projectId: id },
      select: { id: true, name: true, status: true },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  return (
    <ProjectDashboardClient
      project={project}
      teams={teams.map((t) => ({
        id: t.id,
        name: t.name,
        collaboratorOrder: t.collaboratorOrder as unknown as { collaboratorIds: string[] },
      }))}
      tasks={tasks}
    />
  )
}
