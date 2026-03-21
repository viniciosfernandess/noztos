import { notFound, redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSessionUserId } from '@/lib/session'
import { ProjectSettingsForm } from '@/components/ProjectSettingsForm'

interface PageProps {
  params: Promise<{ id: string }>
}

export default async function ProjectSettingsPage({ params }: PageProps) {
  const { id } = await params
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  if (!userId) redirect('/')

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, name: true, userId: true, slackChannel: true },
  })

  if (!project || project.userId !== userId) notFound()

  return (
    <div className="flex flex-col flex-1 bg-zinc-50 font-sans dark:bg-black">
      <header className="flex w-full items-center gap-4 border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <Link
          href={`/projects/${id}`}
          className="text-sm text-zinc-500 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-50"
        >
          &larr; Back to project
        </Link>
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Settings — {project.name}
        </h1>
      </header>
      <main className="flex flex-1 w-full max-w-lg mx-auto flex-col px-6 py-8">
        <ProjectSettingsForm
          projectId={project.id}
          initialName={project.name}
          initialSlackChannel={project.slackChannel ?? ''}
        />
      </main>
    </div>
  )
}
