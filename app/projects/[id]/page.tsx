import { notFound, redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSessionUserId } from '@/lib/session'
import { CollaboratorSection } from '@/components/CollaboratorSection'
import { TeamSection } from '@/components/TeamSection'
import { ChatSection } from '@/components/ChatSection'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectDashboard({ params }: PageProps) {
  const { id } = await params
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  if (!userId) {
    redirect('/')
  }

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      userId: true,
      slackChannel: true,
      createdAt: true,
    },
  })

  // Not found or not owned by this user
  if (!project || project.userId !== userId) {
    notFound()
  }

  // Fetch project data in parallel
  const [collaborators, templates, teams, chatMessages] = await Promise.all([
    prisma.collaborator.findMany({
      where: { projectId: id, isActive: true },
      select: { id: true, name: true, description: true, phase: true, skillMd: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.collaborator.findMany({
      where: { isPlatformDefault: true, projectId: null },
      select: { id: true, name: true, description: true, phase: true },
      orderBy: { name: 'asc' },
    }),
    prisma.team.findMany({
      where: { projectId: id },
      select: { id: true, name: true, collaboratorOrder: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.chatMessage.findMany({
      where: { projectId: id },
      select: { id: true, content: true, sender: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 100,
    }),
  ])

  return (
    <div className="flex flex-col flex-1 bg-zinc-50 font-sans dark:bg-black">
      <header className="flex w-full items-center gap-4 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <Link
          href="/"
          className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          &larr; Home
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          {project.name}
        </h1>
        {project.slackChannel && (
          <span className="text-sm text-zinc-400">{project.slackChannel}</span>
        )}
      </header>

      <main className="flex flex-1 w-full max-w-5xl mx-auto flex-col gap-6 px-6 py-8">
        <CollaboratorSection
          projectId={id}
          collaborators={collaborators}
          templates={templates}
        />

        <TeamSection
          projectId={id}
          teams={teams as { id: string; name: string; collaboratorOrder: { collaboratorIds: string[] } }[]}
          collaborators={collaborators}
        />

        {/* Tasks section — Task 12 */}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Tasks
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Work items assigned to teams. Create tasks to start getting things done.
          </p>
        </section>

        <ChatSection
          projectId={id}
          initialMessages={chatMessages.map((m) => ({
            ...m,
            createdAt: m.createdAt.toISOString(),
          }))}
        />
      </main>
    </div>
  )
}
