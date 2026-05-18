import { EventEmitter } from 'node:events'

// ── Companion Relay ───────────────────────────────────────────────────────
//
// In-memory message relay between the browser and the companion daemon.
// Both sides use SSE (server → client) + POST (client → server), so no
// WebSocket upgrade is needed — works with standard Next.js API routes.
//
// Flow:
//   Browser  → POST /api/companion/command   → relay stores command
//   Companion → GET  /api/companion/events   → SSE emits command to companion
//   Companion → POST /api/companion/response → relay stores event
//   Browser  → GET  /api/companion/stream    → SSE emits event to browser
//
// On top of the raw relay, we also maintain a per-session ring buffer of
// recent stream events. That buffer is what makes re-opening a chat feel
// instant: GET /api/companion/session-state serves from RAM instead of
// round-tripping Supabase. Persistence to Supabase still happens in
// parallel (server write-through + daemon SQLite queue), but the hot
// path never waits on it.
//
// Production: swap the channels Map for Redis pub/sub (same interface)
// and move the session buffer to a shared store. The interface here is
// designed so both can move without rewriting callers.

const MAX_QUEUE_SIZE = 500

// ── Per-session ring buffer knobs ───────────────────────────────────
// Cap per session keeps any single long conversation from dominating
// memory. TTL keeps recently-used chats hot without holding stale ones
// forever. Global byte cap is a hard ceiling for the whole process —
// LRU evicts the least-recently-touched sessions first when breached.
const BUFFER_MAX_EVENTS_PER_SESSION = 200
const BUFFER_TTL_MS = 24 * 60 * 60_000 // 24h
const BUFFER_GLOBAL_BYTE_CAP = 500 * 1024 * 1024 // 500 MB
const BUFFER_SWEEP_INTERVAL_MS = 5 * 60_000 // sweep every 5 min

// ── Companion liveness ──────────────────────────────────────────────
// A companion is "alive" if it heartbeated within the last 60s.
// HEARTBEAT_STALE_MS defines that window. CONN_SWEEP_INTERVAL_MS runs
// the detector periodically: on each tick, any channel whose companion
// has gone stale gets a one-shot "disconnected" broadcast. That flips
// the UI to offline state AND wipes the running chats list so the send
// button unlocks across every open browser tab.
const HEARTBEAT_STALE_MS = 60_000
const CONN_SWEEP_INTERVAL_MS = 15_000

interface CompanionConnection {
  connectedAt: number
  lastHeartbeat: number
  tokenId?: string
  machineName?: string
  // Daemon's `os.homedir()` — used by the worktree provisioner to
  // compute `<homeDir>/.bornastar/worktrees/<projectId>/` server-side
  // without assuming web and daemon share the same home (cloud-ready).
  homeDir?: string
  authInfo?: { email?: string; plan?: string; version?: string }
  projects?: Array<{ id: string; path: string; name: string }>
  // Companion daemon's own package version (e.g. "0.1.0"). Reported on
  // each register/heartbeat and compared against NPM's latest @bornastar/
  // companion to drive the "update available" banner. Optional because
  // older daemon builds (pre-version-reporting) won't send it.
  daemonVersion?: string
}

// A single relayed event as it flows browser-ward. We keep it `unknown`
// at the transport level but narrow it here when we need to peek at the
// payload to decide whether to buffer it.
interface ClaudeEventEnvelope {
  type: string
  payload?: {
    projectId?: string
    bornastarSessionId?: string
    event?: unknown
    [k: string]: unknown
  }
}

interface SessionBuffer {
  userId: string
  events: unknown[]
  lastAccess: number
  bytes: number
}

// Per-user relay channel
class RelayChannel {
  // Commands waiting to be consumed by companion
  commandQueue: unknown[] = []
  commandEmitter = new EventEmitter()

  // Claude events waiting to be consumed by browser
  eventQueue: unknown[] = []
  eventEmitter = new EventEmitter()

  // Companion connection state
  companion: CompanionConnection | null = null

  pushCommand(cmd: unknown): void {
    if (this.commandQueue.length >= MAX_QUEUE_SIZE) this.commandQueue.shift()
    this.commandQueue.push(cmd)
    this.commandEmitter.emit('command', cmd)
  }

  pushEvent(event: unknown, userId: string): void {
    if (this.eventQueue.length >= MAX_QUEUE_SIZE) this.eventQueue.shift()
    this.eventQueue.push(event)
    this.eventEmitter.emit('event', event)

    // Mirror into the per-session ring buffer so later consumers (chat
    // hydration, mobile catch-up) can replay without DB hits.
    maybeBufferEvent(event, userId)
  }

  drainCommands(): unknown[] {
    const cmds = [...this.commandQueue]
    this.commandQueue = []
    return cmds
  }

  drainEvents(): unknown[] {
    const evts = [...this.eventQueue]
    this.eventQueue = []
    return evts
  }

  setCompanionConnected(
    info?: CompanionConnection['authInfo'],
    tokenId?: string,
    machineName?: string,
    homeDir?: string,
    daemonVersion?: string,
  ): void {
    this.companion = {
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      tokenId,
      machineName,
      homeDir,
      authInfo: info,
      daemonVersion,
    }
  }

  setCompanionDisconnected(): void {
    this.companion = null
  }

  heartbeat(): void {
    if (this.companion) this.companion.lastHeartbeat = Date.now()
  }

  isCompanionConnected(): boolean {
    if (!this.companion) return false
    return Date.now() - this.companion.lastHeartbeat < HEARTBEAT_STALE_MS
  }
}

// Global relay store — one channel per user.
//
// Hot-reloads in Next dev (Turbopack) reset module-level variables,
// which would drop every connected-companion state the daemon has
// heartbeated up to now. The browser would then see "companion
// disconnected" for up to one heartbeat window (25 s) every time we
// ship a code change. We pin the Map on `globalThis` so it survives
// module re-evaluation. Production (single cold start) is unaffected.
const globalForRelay = globalThis as unknown as {
  __bornastarCompanionChannels?: Map<string, RelayChannel>
  __bornastarSessionBuffers?: Map<string, SessionBuffer>
  __bornastarBufferSweeper?: NodeJS.Timeout
  __bornastarBufferBytes?: { value: number }
  __bornastarConnSweeper?: NodeJS.Timeout
}
const channels: Map<string, RelayChannel> =
  globalForRelay.__bornastarCompanionChannels ?? new Map<string, RelayChannel>()
const sessionBuffers: Map<string, SessionBuffer> =
  globalForRelay.__bornastarSessionBuffers ?? new Map<string, SessionBuffer>()
// Global byte counter, boxed so hot-reload can share the same ref.
const bufferBytes: { value: number } =
  globalForRelay.__bornastarBufferBytes ?? { value: 0 }

if (process.env.NODE_ENV !== 'production') {
  globalForRelay.__bornastarCompanionChannels = channels
  globalForRelay.__bornastarSessionBuffers = sessionBuffers
  globalForRelay.__bornastarBufferBytes = bufferBytes
}

// Sweeper: prune expired sessions on a timer. LRU eviction happens
// inline inside maybeBufferEvent when the byte cap is breached — no
// need to wait for the sweeper to free headroom.
if (!globalForRelay.__bornastarBufferSweeper) {
  const t = setInterval(sweepExpired, BUFFER_SWEEP_INTERVAL_MS)
  if (typeof t.unref === 'function') t.unref()
  globalForRelay.__bornastarBufferSweeper = t
}

// Companion liveness sweeper: once per CONN_SWEEP_INTERVAL_MS, walk
// every channel and fire a "disconnected" broadcast for channels whose
// companion heartbeat has gone stale. One-shot per transition — once
// the channel is marked disconnected, subsequent sweeps skip it until
// the daemon re-registers.
if (!globalForRelay.__bornastarConnSweeper) {
  const t = setInterval(sweepStaleCompanions, CONN_SWEEP_INTERVAL_MS)
  if (typeof t.unref === 'function') t.unref()
  globalForRelay.__bornastarConnSweeper = t
}

function estimateBytes(evt: unknown): number {
  try {
    // Rough but cheap. JSON byte-length is within a small factor of the
    // V8 heap cost for our shapes, and we only use this to bound total
    // memory — not for precise accounting.
    return Buffer.byteLength(JSON.stringify(evt), 'utf8')
  } catch {
    return 1024 // fallback: assume 1KB for circular/unserialisable payloads
  }
}

function maybeBufferEvent(event: unknown, userId: string): void {
  const env = event as ClaudeEventEnvelope | null
  if (!env || typeof env !== 'object') {
    console.log('[relay-buffer] skip: event is not object')
    return
  }
  // Two frame types persist into the ring:
  //   • claude_event       — the raw Claude stream (chat turns, tool rows)
  //   • workflow_progress  — delta chunks from a running Builder Workflow
  //                          (planner/architect/builder/reviewer transcripts)
  // Status heartbeats, fs_change, running_sessions, pty_* are ephemeral
  // presence signals and never buffer — they'd just waste bytes on replay.
  if (env.type !== 'claude_event' && env.type !== 'workflow_progress') {
    console.log(`[relay-buffer] skip: type=${env.type} (not buffered)`)
    return
  }
  const sessionId = env.payload?.bornastarSessionId
  if (!sessionId) {
    console.log(`[relay-buffer] skip: ${env.type} missing bornastarSessionId`)
    return
  }

  let buf = sessionBuffers.get(sessionId)
  if (!buf) {
    buf = { userId, events: [], lastAccess: Date.now(), bytes: 0 }
    sessionBuffers.set(sessionId, buf)
  }

  const size = estimateBytes(event)
  buf.events.push(event)
  buf.bytes += size
  bufferBytes.value += size
  buf.lastAccess = Date.now()

  const rows = env.payload?.persistRows as unknown
  const hasRows = Array.isArray(rows) && rows.length > 0
  // Workflow chunks fire many per second; throttle their per-push log to
  // milestones (every 25 frames in the session) so a long run doesn't
  // bury the rest of the trace. Chat frames keep one log each (lower rate
  // + persistRows make every push meaningful for debugging).
  if (env.type === 'workflow_progress') {
    if (buf.events.length === 1 || buf.events.length % 25 === 0) {
      const runId = typeof env.payload?.runId === 'string' ? env.payload.runId.slice(0, 8) : '?'
      console.log(`[relay-buffer] push type=workflow_progress sessionId=${sessionId.slice(0, 8)} runId=${runId} events=${buf.events.length} bytes=${buf.bytes}`)
    }
  } else {
    console.log(`[relay-buffer] push type=${env.type} sessionId=${sessionId.slice(0, 8)} events=${buf.events.length} bytes=${buf.bytes} hasPersistRows=${hasRows}`)
  }

  // Per-session FIFO cap. When we drop from the head we also refund
  // bytes so the global counter stays accurate.
  let perSessionDropped = 0
  while (buf.events.length > BUFFER_MAX_EVENTS_PER_SESSION) {
    const dropped = buf.events.shift()
    const droppedSize = estimateBytes(dropped)
    buf.bytes -= droppedSize
    bufferBytes.value -= droppedSize
    perSessionDropped++
  }
  if (perSessionDropped > 0) {
    console.log(`[relay-buffer] per-session cap drop sessionId=${sessionId.slice(0, 8)} dropped=${perSessionDropped} kept=${buf.events.length}/${BUFFER_MAX_EVENTS_PER_SESSION}`)
  }

  // Global byte cap: evict least-recently-accessed sessions until we're
  // back under the ceiling. Never evict the session we just wrote into.
  if (bufferBytes.value > BUFFER_GLOBAL_BYTE_CAP) {
    evictLRU(sessionId)
  }
}

function evictLRU(protectedSessionId: string): void {
  // Build an ordered list once; Map iteration order is insertion order
  // in JS, which doesn't match LRU, so sort explicitly.
  const entries = Array.from(sessionBuffers.entries())
    .filter(([sid]) => sid !== protectedSessionId)
    .sort(([, a], [, b]) => a.lastAccess - b.lastAccess)

  let evicted = 0
  for (const [sid, b] of entries) {
    if (bufferBytes.value <= BUFFER_GLOBAL_BYTE_CAP) break
    bufferBytes.value -= b.bytes
    sessionBuffers.delete(sid)
    evicted++
  }
  if (evicted > 0) {
    console.warn(`[relay-buffer] LRU evicted ${evicted} sessions under byte cap (now ${bufferBytes.value}B / ${BUFFER_GLOBAL_BYTE_CAP}B)`)
  }
}

function sweepExpired(): void {
  const now = Date.now()
  let expired = 0
  for (const [sid, b] of sessionBuffers) {
    if (now - b.lastAccess > BUFFER_TTL_MS) {
      bufferBytes.value -= b.bytes
      sessionBuffers.delete(sid)
      expired++
    }
  }
  if (expired > 0) {
    console.log(`[relay-buffer] TTL sweep removed ${expired} sessions (${sessionBuffers.size} remain, ${bufferBytes.value}B)`)
  }
}

// Detect channels whose companion went silent. We flip server state to
// disconnected, clear the running spinner across every chat, and drop
// any commands the daemon hadn't picked up yet.
//
// Original "honest spinner" design (keep running so a brief network
// blip can resume cleanly) caused a worse UX in practice: when the
// daemon was actually killed (Ctrl+C, Mac sleep, restart), the
// spinner stayed forever and the user thought the chat was stuck.
// Better to abandon and let the user resend than to lie about an
// in-flight turn that's never coming back. The 60s heartbeat-stale
// window already absorbs short blips before this fires.
//
// commandQueue drain prevents "zombie commands": if the daemon comes
// back later, it would otherwise pull the queued prompt and run it
// late, surprising the user with a delayed answer. Cleaner to drop
// here so `offline → online` is a clean slate.
function sweepStaleCompanions(): void {
  const now = Date.now()
  let flipped = 0
  for (const [userId, channel] of channels) {
    const c = channel.companion
    if (!c) continue // already disconnected, nothing to do
    if (now - c.lastHeartbeat < HEARTBEAT_STALE_MS) continue
    const staleFor = now - c.lastHeartbeat
    const dropped = channel.drainCommands().length
    console.warn(`[conn-sweep] userId=${userId.slice(0, 8)} companion offline (staleFor=${staleFor}ms) — broadcasting disconnected, clearing running, dropped=${dropped} pending command(s)`)
    channel.setCompanionDisconnected()
    channel.pushEvent({ type: 'companion_status', connected: false }, userId)
    channel.pushEvent({ type: 'running_sessions', payload: { sessionIds: [] } }, userId)
    flipped++
  }
  if (flipped > 0) {
    console.log(`[conn-sweep] flipped ${flipped} channel(s) to disconnected`)
  }
}

export function getSessionBuffer(sessionId: string, userId: string): unknown[] | null {
  const buf = sessionBuffers.get(sessionId)
  if (!buf) {
    console.log(`[relay-buffer] MISS sessionId=${sessionId.slice(0, 8)} — will fall through to DB`)
    return null
  }
  // Ownership check — a session id leaked across users should never
  // surface another user's events. Defensive; upstream already checks.
  if (buf.userId !== userId) {
    console.warn(`[relay-buffer] ownership mismatch sessionId=${sessionId.slice(0, 8)}`)
    return null
  }
  // Capture the age of the cache BEFORE refreshing lastAccess —
  // otherwise we'd always log 0ms.
  const ageMs = Date.now() - buf.lastAccess
  buf.lastAccess = Date.now()
  console.log(`[relay-buffer] HIT sessionId=${sessionId.slice(0, 8)} events=${buf.events.length} bytes=${buf.bytes} staleFor=${ageMs}ms`)
  return buf.events.slice()
}

export function dropSessionBuffer(sessionId: string): void {
  const buf = sessionBuffers.get(sessionId)
  if (!buf) return
  bufferBytes.value -= buf.bytes
  sessionBuffers.delete(sessionId)
}

// Drop only the frames matching `predicate` (in-place rewrite of the
// session ring). Bytes are refunded to the global counter so the cap
// math stays accurate. Used by the workflow runner to free chunks of
// blocks that have already completed — cache should hold the working
// tip, not the whole history. DB stays as the source of truth for the
// completed work; UI cold-load goes there if a user scrolls back far
// enough that they've evicted from cache.
export function dropFramesByPredicate(
  sessionId: string,
  predicate: (event: unknown) => boolean,
): number {
  const buf = sessionBuffers.get(sessionId)
  if (!buf) return 0
  let dropped = 0
  const kept: unknown[] = []
  for (const ev of buf.events) {
    if (predicate(ev)) {
      const size = estimateBytes(ev)
      buf.bytes -= size
      bufferBytes.value -= size
      dropped++
    } else {
      kept.push(ev)
    }
  }
  if (dropped > 0) {
    buf.events = kept
    console.log(`[relay-buffer] predicate drop sessionId=${sessionId.slice(0, 8)} dropped=${dropped} kept=${buf.events.length} bytes=${buf.bytes}`)
  }
  return dropped
}

export function getBufferStats(): {
  sessions: number
  totalBytes: number
  byteCap: number
  events: number
} {
  let events = 0
  for (const b of sessionBuffers.values()) events += b.events.length
  return {
    sessions: sessionBuffers.size,
    totalBytes: bufferBytes.value,
    byteCap: BUFFER_GLOBAL_BYTE_CAP,
    events,
  }
}

export function getChannel(userId: string): RelayChannel {
  let ch = channels.get(userId)
  if (!ch) {
    ch = new RelayChannel()
    channels.set(userId, ch)
  }
  return ch
}

// Fan-out a command to every companion currently connected. Used for
// global, low-frequency events like prompt-config updates where the
// only "address" we have is "every machine running our daemon right
// now". Iterates the in-memory channels map and pushes the command
// onto each connected channel's queue. Disconnected channels (no SSE
// reader) get the command dropped harmlessly — they'll re-fetch via
// the 5-min polling backup when they reconnect, or via the initial
// /config fetch on startup.
//
// Returns the number of channels that received the command — useful
// for the admin endpoint to log "broadcast to N companions".
export function broadcastCommandToAllCompanions(cmd: unknown): number {
  let n = 0
  for (const ch of channels.values()) {
    if (!ch.isCompanionConnected()) continue
    ch.pushCommand(cmd)
    n++
  }
  return n
}

// Push a single command to one specific user's companion. Returns
// false if there is no connected companion for that user — callers
// decide whether to surface that to the user or fall back to a cloud
// path. Used by companion-exec.ts for request/response round-trips
// (server-issued shell commands that must run on the user's Mac).
export function pushCommandToCompanion(userId: string, cmd: unknown): boolean {
  const ch = channels.get(userId)
  if (!ch?.isCompanionConnected()) return false
  ch.pushCommand(cmd)
  return true
}

export function getCompanionStatus(userId: string): {
  connected: boolean
  connectedAt?: number
  lastSeen?: number
  authInfo?: CompanionConnection['authInfo']
  projects?: CompanionConnection['projects']
  machineName?: string
} {
  const ch = channels.get(userId)
  if (!ch?.companion) {
    return { connected: false }
  }
  const connected = ch.isCompanionConnected()
  return {
    connected,
    connectedAt: ch.companion.connectedAt,
    lastSeen: ch.companion.lastHeartbeat,
    authInfo: ch.companion.authInfo,
    projects: ch.companion.projects,
    machineName: ch.companion.machineName,
  }
}

// Daemon-reported home dir for this user. Used by the worktree
// provisioner to compute the external worktrees root. Returns null when
// the daemon hasn't registered yet — caller should bail with a clear
// error rather than fall back to assumptions.
export function getCompanionHomeDir(userId: string): string | null {
  const ch = channels.get(userId)
  return ch?.companion?.homeDir ?? null
}

