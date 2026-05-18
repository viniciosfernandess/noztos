import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel } from '@/lib/companion-relay'
import { prisma } from '@/lib/db'
import { getLatestCompanionVersion, isUpdateAvailable } from '@/lib/companion-version-check'

// POST — Companion daemon registers itself. Sends auth info (Claude
// version, email, plan) and project list. Server marks the user's
// relay channel as "companion connected" so the browser knows.
export async function POST(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { authInfo, daemonVersion, projects, machineName, homeDir } = body as {
    authInfo?: { email?: string; plan?: string; version?: string }
    // Companion daemon's own package version (e.g. "0.1.0"). Compared
    // against the latest published @noztos/companion on NPM to
    // surface an "update available" hint to the browser.
    daemonVersion?: string
    projects?: Array<{ id: string; path: string; name: string }>
    machineName?: string
    homeDir?: string
  }

  const channel = getChannel(auth.userId)
  const wasConnected = channel.isCompanionConnected()

  // NPM latest lookup is part of the fingerprint, so do it FIRST so the
  // prior/next comparison is fair. Cached 30 min — cheap on the hot path.
  const latestVersion = await getLatestCompanionVersion()

  // Capture a fingerprint of the prior broadcast payload BEFORE
  // setCompanionConnected mutates it. The fingerprint covers EXACTLY
  // the fields that go into the companion_status broadcast — that
  // structural coupling means future additions to the broadcast
  // automatically participate in change detection. No more bugs from
  // "I added X to the payload but forgot to add X to the diff check".
  // The same `latestVersion` flows into both fingerprints so a stale-
  // cache flip (e.g. the daemon stayed connected but a new NPM release
  // landed) shows up as a fingerprint diff and re-broadcasts.
  const priorFingerprint = wasConnected ? statusFingerprint(channel.companion, latestVersion) : null
  channel.setCompanionConnected(authInfo, auth.tokenId, machineName ?? auth.tokenName, homeDir, daemonVersion)
  if (projects) {
    if (channel.companion) channel.companion.projects = projects
  }
  const updateAvailable = isUpdateAvailable(daemonVersion, latestVersion)
  const nextFingerprint = statusFingerprint(channel.companion, latestVersion)

  // Reconcile daemon-side projects against DB state. Two cases:
  //   1. Daemon's id is the legacy hex (24 char), DB has a Repository
  //      whose localPath matches → enqueue `relabel_project` so the
  //      daemon adopts the DB cuid. This makes fs-watcher path,
  //      worktrees dir, and provisionWorktree all line up.
  //   2. Daemon has a project the DB doesn't (deleted or never
  //      created) → enqueue `unregister_project` + `cleanup_project`
  //      so the daemon drops the local entry and rms the worktrees
  //      dir. Recovers from "user deleted while daemon was offline".
  //
  // Both commands are async/queued — zero added ms in the register
  // response. Idempotent: if daemon already adopted the cuid (or the
  // project is already gone) the daemon's own handlers no-op.
  if (projects && projects.length > 0) {
    void reconcileProjects(auth.userId, projects, channel)
  }

  // (latestVersion + updateAvailable already computed above before the
  // fingerprint comparison.)

  // Only broadcast companion_status when the snapshot actually
  // changed. A heartbeat with identical state stays silent so we
  // don't spam every SSE listener every 10s. New browser tabs still
  // get their initial status from the SSE handshake in stream/route.ts.
  if (priorFingerprint !== nextFingerprint) {
    const projIds = (channel.companion?.projects ?? []).map((p) => `${p.name}:${p.id.slice(0, 8)}`).join(',')
    console.log(`[register] FINGERPRINT CHANGED userId=${auth.userId.slice(0, 8)} wasConnected=${wasConnected}`)
    console.log(`[register]   prior=${priorFingerprint?.slice(0, 200) ?? 'null'}`)
    console.log(`[register]   next=${nextFingerprint.slice(0, 200)}`)
    console.log(`[register]   broadcasting companion_status with projects=[${projIds}]`)
    channel.pushEvent({
      type: 'companion_status',
      connected: true,
      authInfo,
      projects: channel.companion?.projects,
      machineName: channel.companion?.machineName,
      daemonVersion,
      latestVersion,
      updateAvailable,
    }, auth.userId)
  }

  return NextResponse.json({
    ok: true,
    message: 'Companion registered',
    pendingCommands: channel.drainCommands().length,
  })
}

// Reconcile daemon's local project list against DB state. Runs in the
// background after register; never blocks the response. Issues
// relabel/unregister/cleanup commands as needed; daemon handlers are
// idempotent so repeated reconciliations on heartbeats are safe.
//
// Looks up DB rows by the file path the daemon reported (matched to
// `Repository.localPath`). Cuid format check (>=20 chars, starts with
// 'c') identifies daemon ids that are already cuids — those are
// trusted as-is. Hex (24 chars) means legacy → relabel.
async function reconcileProjects(
  userId: string,
  daemonProjects: Array<{ id: string; path: string; name: string }>,
  channel: ReturnType<typeof getChannel>,
): Promise<void> {
  const tStart = Date.now()
  try {
    const paths = daemonProjects.map((p) => p.path)
    // Local-path projects store their disk root in `Repository.sandboxId`
    // (legacy field name — predates the multi-flow picker). Cross-
    // referencing daemon-reported paths against this column is what
    // links the daemon's local registry to the DB cuid.
    const repos = await prisma.repository.findMany({
      where: {
        sandboxId: { in: paths },
        project: { userId },
      },
      select: {
        sandboxId: true,
        project: { select: { id: true, deletedAt: true } },
      },
    })
    const byPath = new Map(
      repos
        .filter((r): r is typeof r & { sandboxId: string } => r.sandboxId !== null)
        .map((r) => [r.sandboxId, r.project] as const),
    )
    let drops = 0, relabels = 0, untouched = 0
    for (const dp of daemonProjects) {
      const dbProj = dp.path ? byPath.get(dp.path) : undefined
      if (!dbProj) {
        // daemon-only project, leave alone (e.g., never registered with cloud)
        untouched++
        continue
      }
      if (dbProj.deletedAt) {
        // Project was deleted while daemon was offline. Tell daemon to
        // drop the local registration and rm the worktrees dir.
        const homeDir = channel.companion?.homeDir
        channel.pushCommand({ type: 'unregister_project', targetPath: dp.path, timestamp: Date.now() })
        if (homeDir) {
          channel.pushCommand({
            type: 'cleanup_project',
            worktreesPath: `${homeDir}/.bornastar/worktrees/${dbProj.id}`,
            timestamp: Date.now(),
          })
        }
        console.log(`[register] reconcile drop deleted project path=${dp.path} cuid=${dbProj.id.slice(0, 8)}`)
        drops++
      } else if (dp.id !== dbProj.id) {
        // Daemon has the legacy hex id; tell it to adopt the DB cuid.
        channel.pushCommand({
          type: 'relabel_project',
          oldProjectId: dp.id,
          newProjectId: dbProj.id,
          timestamp: Date.now(),
        })
        console.log(`[register] reconcile relabel ${dp.id.slice(0, 8)} → ${dbProj.id.slice(0, 8)} path=${dp.path}`)
        relabels++
      } else {
        untouched++
      }
    }
    if (drops > 0 || relabels > 0) {
      console.log(`[register] reconcile SUMMARY user=${userId.slice(0, 8)} daemonProjects=${daemonProjects.length} drops=${drops} relabels=${relabels} untouched=${untouched} ms=${Date.now() - tStart}`)
    } else {
      console.log(`[register] reconcile in-sync user=${userId.slice(0, 8)} projects=${daemonProjects.length} ms=${Date.now() - tStart}`)
    }
  } catch (err) {
    console.warn(`[register] reconcile failed user=${userId.slice(0, 8)}: ${(err as Error).message}`)
  }
}

// Snapshot of the companion fields that go into the companion_status
// broadcast. KEEP THIS IN SYNC with the pushEvent payload above —
// every field in the broadcast must be in the fingerprint, and vice
// versa. Sorted projectIds because order changes are not meaningful
// (the daemon may iterate config differently).
function statusFingerprint(
  companion: { authInfo?: { email?: string; plan?: string; version?: string }; projects?: Array<{ id: string }>; machineName?: string; daemonVersion?: string } | null | undefined,
  latestVersion: string | null,
): string {
  if (!companion) return 'null'
  return JSON.stringify({
    email: companion.authInfo?.email ?? null,
    plan: companion.authInfo?.plan ?? null,
    version: companion.authInfo?.version ?? null,
    machineName: companion.machineName ?? null,
    projectIds: (companion.projects ?? []).map((p) => p.id).sort(),
    // Daemon's own version + the latest NPM version both flow into the
    // fingerprint so a daemon upgrade OR a new NPM release flips the
    // broadcast — banner state stays fresh without polling on the
    // browser.
    daemonVersion: companion.daemonVersion ?? null,
    latestVersion,
  })
}

// DELETE — Companion disconnects gracefully. Broadcasts disconnected
// status + empty running list so open browser tabs flip to offline
// state without waiting for the heartbeat sweeper.
export async function DELETE(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const channel = getChannel(auth.userId)
  const dropped = channel.drainCommands().length
  channel.setCompanionDisconnected()
  channel.pushEvent({ type: 'companion_status', connected: false }, auth.userId)
  channel.pushEvent({ type: 'running_sessions', payload: { sessionIds: [] } }, auth.userId)
  console.log(`[register] companion graceful disconnect userId=${auth.userId.slice(0, 8)} dropped=${dropped} pending command(s)`)
  return NextResponse.json({ ok: true })
}
