'use client'

import { ClaudeBadge } from './ClaudeBadge'
import { SlackBadge } from './SlackBadge'
import type { BadgeState } from './ClaudeBadge'
import type { SlackBadgeState } from './SlackBadge'

interface HeaderProps {
  claudeState: BadgeState
  slackState: SlackBadgeState
}

export function Header({ claudeState, slackState }: HeaderProps) {
  return (
    <header className="flex w-full items-center justify-between border-b border-zinc-200 bg-white px-6 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Bornastar
      </h1>
      <div className="flex items-center gap-2">
        <ClaudeBadge state={claudeState} />
        <SlackBadge state={slackState} />
      </div>
    </header>
  )
}
