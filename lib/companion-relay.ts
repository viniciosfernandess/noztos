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
// Each user gets their own channel. Messages are fire-and-forget — if no
// listener is connected, messages are queued (up to MAX_QUEUE_SIZE) and
// drained when the listener reconnects.
//
// Production: swap this for Redis pub/sub. Same interface, horizontal scale.

const MAX_QUEUE_SIZE = 500

interface CompanionConnection {
  connectedAt: number
  lastHeartbeat: number
  authInfo?: { email?: string; plan?: string; version?: string }
  projects?: Array<{ id: string; path: string; name: string }>
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

  pushEvent(event: unknown): void {
    if (this.eventQueue.length >= MAX_QUEUE_SIZE) this.eventQueue.shift()
    this.eventQueue.push(event)
    this.eventEmitter.emit('event', event)
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

  setCompanionConnected(info?: CompanionConnection['authInfo']): void {
    this.companion = {
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      authInfo: info,
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
    // Consider disconnected if no heartbeat for 60s
    return Date.now() - this.companion.lastHeartbeat < 60_000
  }
}

// Global relay store — one channel per user
const channels = new Map<string, RelayChannel>()

export function getChannel(userId: string): RelayChannel {
  let ch = channels.get(userId)
  if (!ch) {
    ch = new RelayChannel()
    channels.set(userId, ch)
  }
  return ch
}

export function getCompanionStatus(userId: string): {
  connected: boolean
  connectedAt?: number
  authInfo?: CompanionConnection['authInfo']
  projects?: CompanionConnection['projects']
} {
  const ch = channels.get(userId)
  if (!ch?.companion || !ch.isCompanionConnected()) {
    return { connected: false }
  }
  return {
    connected: true,
    connectedAt: ch.companion.connectedAt,
    authInfo: ch.companion.authInfo,
    projects: ch.companion.projects,
  }
}

export type { RelayChannel, CompanionConnection }
