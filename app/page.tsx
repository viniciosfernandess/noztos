import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'
import { ClaudeBadge } from '@/components/ClaudeBadge'
import { SlackBadge } from '@/components/SlackBadge'
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

  if (params.error) {
    badgeState = 'error'
  } else if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { anthropicToken: true, slackToken: true },
    })
    badgeState = user?.anthropicToken ? 'connected' : 'needs_reconnect'
    slackState = user?.slackToken ? 'connected' : 'not_connected'
  }

  if (params.slack_error) {
    slackState = 'error'
  }

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex flex-1 w-full max-w-3xl flex-col items-center justify-between py-32 px-16 bg-white dark:bg-black sm:items-start">
        <div className="flex w-full items-center justify-between">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            Bornastar
          </h1>
          <div className="flex items-center gap-2">
            <ClaudeBadge state={badgeState} />
            <SlackBadge state={slackState} />
          </div>
        </div>
        <div className="flex flex-col items-center gap-6 text-center sm:items-start sm:text-left">
          <p className="max-w-md text-lg leading-8 text-zinc-600 dark:text-zinc-400">
            Create AI-powered companies with teams of AI employees that
            collaborate to build your projects.
          </p>
        </div>
      </main>
    </div>
  )
}
