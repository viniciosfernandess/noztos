// Admin dashboard. Server component — every metric is a Prisma
// aggregate on first paint. No live updates yet; refresh the page
// or hit the buttons.
//
// Scope: 10-user MVP. Two zones:
//   1. KPI cards — demand signals at a glance (users, signups,
//      sessions, sandboxes spun up, tokens, mirror traffic).
//   2. Activity feed — recent events stitched from a handful of
//      tables (User signups, Project creates, SandboxSession
//      provisions, password resets). Newest first, last ~50 entries.
//
// Auth: gated by ADMIN_USER_IDS env var. Non-admin / signed-out
// visitors get a 404 so the URL doesn't leak existence.

import { notFound } from 'next/navigation'
import { prisma } from '@/lib/db'
import { requireAdmin } from '@/lib/admin'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function loadMetrics() {
  const now = new Date()
  const start24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const start7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const start30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [
    totalUsers,
    signups24h,
    signups7d,
    activeUsers7d,
    totalProjects,
    sessions24h,
    sandboxes24h,
    sandboxesActive,
    sandboxesAllTime,
    messages24h,
    tokenSums24h,
    tokenSums7d,
    mirrorBlobs24h,
    mirrorBlobsTotal,
    mirrorEntriesTotal,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: start24h } } }),
    prisma.user.count({ where: { createdAt: { gte: start7d } } }),
    prisma.user.count({ where: { lastActive: { gte: start7d } } }),
    prisma.project.count({ where: { deletedAt: null } }),
    prisma.chatSession.count({ where: { createdAt: { gte: start24h }, deletedAt: null } }),
    prisma.sandboxSession.count({ where: { createdAt: { gte: start24h } } }),
    prisma.sandboxSession.count({ where: { status: 'ready', destroyedAt: null } }),
    prisma.sandboxSession.count(),
    prisma.chatMessage.count({ where: { createdAt: { gte: start24h } } }),
    prisma.chatMessage.aggregate({
      where: { createdAt: { gte: start24h } },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.chatMessage.aggregate({
      where: { createdAt: { gte: start7d } },
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.gitObject.count({ where: { createdAt: { gte: start24h } } }),
    prisma.gitObject.count(),
    prisma.worktreeFileEntry.count(),
  ])

  return {
    now, start24h, start7d, start30d,
    totalUsers, signups24h, signups7d, activeUsers7d,
    totalProjects, sessions24h,
    sandboxes24h, sandboxesActive, sandboxesAllTime,
    messages24h, tokenSums24h, tokenSums7d,
    mirrorBlobs24h, mirrorBlobsTotal, mirrorEntriesTotal,
  }
}

interface ActivityEvent {
  ts: Date
  kind: 'signup' | 'project' | 'session' | 'sandbox' | 'password_reset'
  who: string
  detail: string
}

async function loadActivity(): Promise<ActivityEvent[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  // Fetch each event source then do a single User lookup to attach
  // emails. Not all event tables have a `user` relation declared in
  // the Prisma schema, so doing it manually avoids chasing those
  // declarations across the codebase.
  const [users, projects, sessions, sandboxes, resets] = await Promise.all([
    prisma.user.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { id: true, email: true, name: true, createdAt: true },
    }),
    prisma.project.findMany({
      where: { createdAt: { gte: since }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { name: true, createdAt: true, userId: true },
    }),
    prisma.chatSession.findMany({
      where: { createdAt: { gte: since }, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { name: true, createdAt: true, userId: true },
    }),
    prisma.sandboxSession.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { status: true, createdAt: true, e2bSandboxId: true, userId: true },
    }),
    prisma.passwordResetToken.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: { createdAt: true, userId: true },
    }),
  ])

  const userIds = new Set<string>()
  for (const r of [...projects, ...sessions, ...sandboxes, ...resets]) userIds.add(r.userId)
  for (const u of users) userIds.add(u.id)
  const userMap = new Map(
    (await prisma.user.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { id: true, email: true },
    })).map((u) => [u.id, u.email]),
  )
  const email = (uid: string): string => userMap.get(uid) ?? '(unknown)'

  const events: ActivityEvent[] = [
    ...users.map((u) => ({ ts: u.createdAt, kind: 'signup' as const, who: u.email, detail: u.name })),
    ...projects.map((p) => ({ ts: p.createdAt, kind: 'project' as const, who: email(p.userId), detail: p.name })),
    ...sessions.map((s) => ({ ts: s.createdAt, kind: 'session' as const, who: email(s.userId), detail: s.name })),
    ...sandboxes.map((s) => ({ ts: s.createdAt, kind: 'sandbox' as const, who: email(s.userId), detail: `${s.status} ${s.e2bSandboxId ? '· ' + s.e2bSandboxId.slice(0, 12) : ''}` })),
    ...resets.map((r) => ({ ts: r.createdAt, kind: 'password_reset' as const, who: email(r.userId), detail: 'reset link sent' })),
  ]
  events.sort((a, b) => b.ts.getTime() - a.ts.getTime())
  return events.slice(0, 80)
}

export default async function AdminDashboard() {
  const auth = await requireAdmin()
  if (!auth) notFound()

  const [metrics, activity] = await Promise.all([loadMetrics(), loadActivity()])

  return (
    <>
      <style>{`
        :root {
          --bg: oklch(0.13 0.008 255);
          --bg-2: oklch(0.16 0.009 255);
          --bg-3: oklch(0.19 0.01 255);
          --fg: oklch(0.96 0.005 255);
          --muted: oklch(0.62 0.012 255);
          --muted-2: oklch(0.45 0.012 255);
          --line: oklch(0.26 0.012 255);
          --line-2: oklch(0.22 0.012 255);
          --accent: oklch(0.88 0.19 130);
        }
        body { background: var(--bg); color: var(--fg); margin: 0; padding: 0; font-family: 'Space Grotesk', ui-sans-serif, system-ui, sans-serif; }
        .admin-grid {
          display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 12px; margin-bottom: 32px;
        }
        .card {
          border: 1px solid var(--line); background: var(--bg-2);
          padding: 16px 18px; border-radius: 6px;
        }
        .card .label {
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
          color: var(--muted-2);
        }
        .card .value {
          font-family: 'Space Grotesk', ui-sans-serif, sans-serif;
          font-size: 30px; font-weight: 500; letter-spacing: -0.02em;
          color: var(--fg); margin-top: 6px;
        }
        .card .sub {
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          font-size: 11px; color: var(--muted); margin-top: 4px;
        }
        .card .sub .accent { color: var(--accent); }
        .activity {
          border: 1px solid var(--line); background: var(--bg-2);
          border-radius: 6px; overflow: hidden;
        }
        .activity h2 {
          font-family: 'JetBrains Mono', ui-monospace, monospace;
          font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em;
          color: var(--muted); margin: 0; padding: 14px 18px;
          border-bottom: 1px solid var(--line);
        }
        .activity table {
          width: 100%; border-collapse: collapse;
          font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px;
        }
        .activity td {
          padding: 8px 18px; border-bottom: 1px solid var(--line-2);
          color: var(--muted); vertical-align: top;
        }
        .activity tr:last-child td { border-bottom: none; }
        .activity .kind {
          display: inline-block; padding: 1px 6px; border-radius: 3px;
          font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em;
          margin-right: 6px;
        }
        .kind-signup { background: oklch(0.88 0.19 130 / 0.15); color: var(--accent); }
        .kind-project { background: oklch(0.6 0.18 260 / 0.15); color: oklch(0.78 0.16 260); }
        .kind-session { background: oklch(0.55 0.18 280 / 0.15); color: oklch(0.78 0.16 280); }
        .kind-sandbox { background: oklch(0.55 0.18 220 / 0.15); color: oklch(0.78 0.16 220); }
        .kind-password_reset { background: oklch(0.55 0.18 45 / 0.15); color: oklch(0.78 0.16 45); }
        .activity .who { color: var(--fg); }
        .activity .ts {
          color: var(--muted-2); white-space: nowrap;
          width: 1%;
        }
      `}</style>

      <nav style={{ borderBottom: '1px solid var(--line)', padding: '14px 28px', display: 'flex', alignItems: 'center', gap: 32 }}>
        <a href="/" style={{ color: 'var(--fg)', fontFamily: 'Space Grotesk, sans-serif', fontWeight: 600, fontSize: 18, letterSpacing: '-0.01em', textDecoration: 'none' }}>noztos</a>
        <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.14em' }}>
          admin · {new Date().toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}
        </span>
      </nav>

      <main style={{ maxWidth: 1280, margin: '0 auto', padding: '32px 28px 80px' }}>
        <h1 style={{ fontFamily: 'Space Grotesk, sans-serif', fontWeight: 500, fontSize: 36, letterSpacing: '-0.02em', margin: '0 0 8px' }}>
          Demand
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 14, margin: '0 0 32px' }}>
          Real-time numbers from the database. Refresh the page to recompute.
        </p>

        <div className="admin-grid">
          <Card label="Total users" value={metrics.totalUsers} sub={<><span className="accent">+{metrics.signups7d}</span> last 7 days</>} />
          <Card label="Signups · 24h" value={metrics.signups24h} sub={`${metrics.signups7d} in last 7d`} />
          <Card label="Active users · 7d" value={metrics.activeUsers7d} sub={`of ${metrics.totalUsers} total`} />
          <Card label="Open projects" value={metrics.totalProjects} />
          <Card label="New chats · 24h" value={metrics.sessions24h} />
          <Card label="Sandboxes · 24h" value={metrics.sandboxes24h} sub={`${metrics.sandboxesActive} active now`} />
          <Card label="Messages · 24h" value={metrics.messages24h} />
          <Card
            label="Tokens · 24h"
            value={fmtInt((metrics.tokenSums24h._sum.inputTokens ?? 0) + (metrics.tokenSums24h._sum.outputTokens ?? 0))}
            sub={metrics.tokenSums24h._sum.costUsd ? `≈ $${(metrics.tokenSums24h._sum.costUsd).toFixed(2)}` : '$0.00'}
          />
          <Card
            label="Tokens · 7d"
            value={fmtInt((metrics.tokenSums7d._sum.inputTokens ?? 0) + (metrics.tokenSums7d._sum.outputTokens ?? 0))}
            sub={metrics.tokenSums7d._sum.costUsd ? `≈ $${(metrics.tokenSums7d._sum.costUsd).toFixed(2)}` : '$0.00'}
          />
          <Card label="Mirror blobs · 24h" value={metrics.mirrorBlobs24h} sub={`${fmtInt(metrics.mirrorBlobsTotal)} total`} />
          <Card label="Mirror file entries" value={fmtInt(metrics.mirrorEntriesTotal)} />
          <Card label="Sandboxes · all time" value={metrics.sandboxesAllTime} />
        </div>

        <div className="activity">
          <h2>Recent activity · last 7 days</h2>
          {activity.length === 0 ? (
            <div style={{ padding: 24, color: 'var(--muted-2)', fontSize: 13 }}>(no events yet)</div>
          ) : (
            <table>
              <tbody>
                {activity.map((e, i) => (
                  <tr key={i}>
                    <td className="ts">{relTime(e.ts)}</td>
                    <td>
                      <span className={`kind kind-${e.kind}`}>{e.kind}</span>
                      <span className="who">{e.who}</span>
                      <span style={{ color: 'var(--muted-2)', marginLeft: 8 }}>· {e.detail}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  )
}

function Card({ label, value, sub }: { label: string; value: number | string; sub?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub !== undefined && <div className="sub">{sub}</div>}
    </div>
  )
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function relTime(ts: Date): string {
  const diff = Date.now() - ts.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`
  return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`
}
