import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'
import { Header } from '@/components/Header'
import { ProjectList } from '@/components/ProjectList'
import type { BadgeState } from '@/components/ClaudeBadge'
import type { SlackBadgeState } from '@/components/SlackBadge'

interface PageProps {
  searchParams: Promise<{ error?: string; slack_error?: string }>
}

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  let badgeState: BadgeState = 'none'
  let slackState: SlackBadgeState = 'not_connected'
  let projects: { id: string; name: string; createdAt: Date }[] = []

  if (params.error) {
    badgeState = 'error'
  } else if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        anthropicToken: true,
        slackToken: true,
        projects: {
          select: { id: true, name: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    badgeState = user?.anthropicToken ? 'connected' : 'needs_reconnect'
    slackState = user?.slackToken ? 'connected' : 'not_connected'
    projects = user?.projects ?? []
  }

  if (params.slack_error) {
    slackState = 'error'
  }

  return (
    <div className="flex flex-col flex-1 bg-zinc-50 font-sans dark:bg-black">
      <Header claudeState={badgeState} slackState={slackState} />
      <main className="flex flex-1 w-full max-w-4xl mx-auto flex-col px-6 py-8">
        <ProjectList projects={projects} />
      </main>
    </div>
  )
}
