import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/crypto'

/**
 * Send a Slack notification for a project event and log it.
 * Uses the project's Slack webhook if configured, or the user's Slack token.
 * Logs the attempt regardless of delivery success.
 */
export async function notifySlack(params: {
  projectId: string
  taskId?: string
  message: string
}): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: params.projectId },
    select: {
      slackWebhook: true,
      slackChannel: true,
      user: { select: { slackToken: true } },
    },
  })

  if (!project) return

  const channel = project.slackChannel ?? 'general'
  let delivered = false

  // Try webhook first, then user token
  if (project.slackWebhook) {
    try {
      const res = await fetch(project.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: params.message }),
      })
      delivered = res.ok
    } catch {
      // Log failure below
    }
  } else if (project.user.slackToken) {
    try {
      const token = decrypt(project.user.slackToken)
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          channel,
          text: params.message,
        }),
      })
      const data = await res.json()
      delivered = data.ok === true
    } catch {
      // Log failure below
    }
  }

  // Always log the attempt
  await prisma.slackLog.create({
    data: {
      projectId: params.projectId,
      taskId: params.taskId ?? null,
      messageSent: params.message,
      channel,
      delivered,
    },
  })
}
