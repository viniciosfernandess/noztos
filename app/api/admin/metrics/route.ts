import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUserId } from '@/lib/session'
import { prisma } from '@/lib/db'
import { getBufferStats } from '@/lib/companion-relay'

// GET — Internal metrics snapshot for the persistence pipeline.
//
// Intentionally a single poll endpoint rather than a Prometheus exporter:
// the data is small, live-polled by a human via `curl` or a /admin page,
// and the interesting counters already live in memory.
//
// Gated on an ADMIN_USER_ID env var. Exposing the ring buffer shape to
// every authenticated user would leak inference about how much chat
// traffic other users generate.
export async function GET() {
  const cookieStore = await cookies()
  const userId = getSessionUserId(cookieStore.get('session')?.value)
  const admins = (process.env.ADMIN_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!userId || admins.length === 0 || !admins.includes(userId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const ringBuffer = getBufferStats()
  const now = new Date()

  // Cheap aggregates — all three are index-backed (userId+lastMessageAt,
  // projectId+status). Happy to expand this list as new signals become
  // load-bearing.
  const [openChats, archivedChats, activeLastHour, messagesLastHour] = await Promise.all([
    prisma.chatSession.count({ where: { status: 'open', deletedAt: null } }),
    prisma.chatSession.count({ where: { status: 'archived', deletedAt: null } }),
    prisma.chatSession.count({
      where: {
        lastMessageAt: { gte: new Date(now.getTime() - 60 * 60_000) },
        deletedAt: null,
      },
    }),
    prisma.chatMessage.count({
      where: {
        createdAt: { gte: new Date(now.getTime() - 60 * 60_000) },
        deletedAt: null,
      },
    }),
  ])

  return NextResponse.json({
    at: now.toISOString(),
    ringBuffer: {
      sessions: ringBuffer.sessions,
      events: ringBuffer.events,
      bytes: ringBuffer.totalBytes,
      byteCap: ringBuffer.byteCap,
      utilization: ringBuffer.byteCap > 0
        ? Math.round((ringBuffer.totalBytes / ringBuffer.byteCap) * 10000) / 100
        : 0,
    },
    chatSessions: {
      open: openChats,
      archived: archivedChats,
      activeLastHour,
    },
    chatMessages: {
      lastHour: messagesLastHour,
    },
  })
}
