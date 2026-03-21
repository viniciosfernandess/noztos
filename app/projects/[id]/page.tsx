import { notFound, redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { prisma } from '@/lib/db'
import { getSessionUserId } from '@/lib/session'

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
        {/* Collaborators section — Task 7 */}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Collaborators
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            AI employees that work on this project. Add collaborators to build your team.
          </p>
        </section>

        {/* Teams section — Task 8 */}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Teams
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Organize collaborators into teams with defined workflows and pipelines.
          </p>
        </section>

        {/* Tasks section — Task 12 */}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Tasks
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Work items assigned to teams. Create tasks to start getting things done.
          </p>
        </section>

        {/* Chat section — Task 10 */}
        <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            Chat
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Talk to your AI team. Give instructions, ask questions, review work.
          </p>
        </section>
      </main>
    </div>
  )
}
