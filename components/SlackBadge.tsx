'use client'

export type SlackBadgeState = 'connected' | 'not_connected' | 'error'

const CONFIG: Record<SlackBadgeState, { dot: string; label: string; title: string }> = {
  connected: {
    dot: 'bg-emerald-500',
    label: 'Slack connected',
    title: 'Slack workspace connected',
  },
  not_connected: {
    dot: 'bg-zinc-300',
    label: 'Connect Slack',
    title: 'Connect your Slack workspace',
  },
  error: {
    dot: 'bg-red-500',
    label: 'Slack error — retry',
    title: 'Slack authentication failed. Click to try again.',
  },
}

interface SlackBadgeProps {
  state: SlackBadgeState
}

export function SlackBadge({ state }: SlackBadgeProps) {
  const { dot, label, title } = CONFIG[state]

  return (
    <a
      href="/api/auth/slack/start"
      title={title}
      className="flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
    >
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {label}
    </a>
  )
}
