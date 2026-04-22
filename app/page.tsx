import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'
import { Header } from '@/components/Header'
import { ProjectList } from '@/components/ProjectList'
import { CompanionSetup } from '@/components/CompanionSetup'
import { DashboardSidebar } from '@/components/DashboardSidebar'

export default async function Home() {
  const cookieStore = await cookies()
  const sessionValue = cookieStore.get('session')?.value
  const userId = getSessionUserId(sessionValue)

  let projects: { id: string; name: string; createdAt: Date }[] = []
  let userName = ''
  let hasCompanionToken = false

  if (userId) {
    const [user, tokenCount] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          name: true,
          projects: {
            where: { deletedAt: null },
            select: { id: true, name: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      prisma.companionToken.count({ where: { userId } }),
    ])

    projects = user?.projects ?? []
    userName = user?.name ?? ''
    hasCompanionToken = tokenCount > 0
  }

  return (
    <div className="flex flex-col flex-1 font-sans" style={{ backgroundColor: '#1a1a22' }}>
      <Header userName={userName} />
      <div className="flex flex-1 overflow-hidden">
        {hasCompanionToken && <DashboardSidebar />}
        <main className="flex flex-1 flex-col px-6 py-8 overflow-y-auto">
          <div className="w-full max-w-4xl mx-auto flex-1">
            {!hasCompanionToken ? (
              <CompanionSetup />
            ) : (
              <ProjectList projects={projects} />
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
