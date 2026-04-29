// Server-fetched prompt config loader.
//
// On daemon startup we call refreshPromptConfig() once to seed the
// in-memory store (claude-bridge's `activeConfig`) with whatever the
// backend currently has in companion_config. After that, refresh fires
// in two situations:
//   1. SSE 'config_updated' event arrives (push, <1s after edit)
//   2. 5-minute backup poll detects a version mismatch (in case SSE
//      silently dropped a reconnect)
//
// This module is fail-soft on every error path: if anything goes wrong
// the daemon keeps using its existing activeConfig, which is either
// the bundled defaults (haven't fetched yet) or the most recent good
// fetch. The user never sees a broken state.
//
// Does NOT cache to disk — that's intentional. Prompts only ever live
// in RAM (privacy by design). On reboot we fetch fresh from server,
// or fall back to bundled if offline.

import { setActiveConfig, type ActiveConfig, type BornastarMode } from './claude-bridge.js'
import { loadConfig } from './config.js'

// Default backup-polling interval. Server-side push via SSE should
// deliver updates in <1s; this is just paranoia in case the SSE
// channel silently dropped without a clean reconnect.
const POLL_INTERVAL_MS = 5 * 60 * 1000

let pollTimer: ReturnType<typeof setInterval> | null = null

// Validates a server response payload before applying it. We're paranoid
// here because a bad payload (truncated, schema mismatch, anything that
// changes) would otherwise replace a working `activeConfig` with one
// that breaks every spawn — much worse than just refusing to update.
//
// Returns null when the payload is invalid; caller should keep the
// existing activeConfig in that case.
function validate(payload: unknown): ActiveConfig | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.version !== 'string' || p.version.length === 0) return null
  if (typeof p.namingRule !== 'string') return null

  // modePrompts shape: { plan: string, ask: string, agent: string }
  const mp = p.modePrompts
  if (!mp || typeof mp !== 'object') return null
  const mpRec = mp as Record<string, unknown>
  for (const mode of ['plan', 'ask', 'agent'] as BornastarMode[]) {
    if (typeof mpRec[mode] !== 'string') return null
  }

  // disallowedTools shape: { plan: string[], ask: string[], agent: string[] }
  const dt = p.disallowedTools
  if (!dt || typeof dt !== 'object') return null
  const dtRec = dt as Record<string, unknown>
  for (const mode of ['plan', 'ask', 'agent'] as BornastarMode[]) {
    const v = dtRec[mode]
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return null
  }

  return {
    modePrompts: mpRec as Record<BornastarMode, string>,
    namingRule: p.namingRule,
    disallowedTools: dtRec as Record<BornastarMode, string[]>,
    version: p.version,
  }
}

// Fetches the full prompt config and applies it. Returns true on
// successful apply, false on any failure (network, auth, validation).
// Failure leaves activeConfig untouched.
//
// `trigger` is just a label for log readability — distinguishes
// between the startup fire-and-forget, the SSE push, and the polling
// drift fallback so you can tell from terminal what actually fired.
export async function refreshPromptConfig(trigger: 'startup' | 'sse-push' | 'poll-drift' | 'manual' = 'manual'): Promise<boolean> {
  const local = loadConfig()
  if (!local.authToken) {
    console.log(`[prompt-config] refresh trigger=${trigger} skipped — daemon has no authToken yet (bundled stays active)`)
    return false
  }

  console.log(`[prompt-config] refresh trigger=${trigger} fetching /config...`)
  try {
    const res = await fetch(`${local.serverUrl}/api/companion/config`, {
      headers: { Authorization: `Bearer ${local.authToken}` },
    })
    if (!res.ok) {
      console.log(`[prompt-config] refresh trigger=${trigger} status=${res.status} — keeping current activeConfig`)
      return false
    }
    const payload: unknown = await res.json()
    const next = validate(payload)
    if (!next) {
      console.warn(`[prompt-config] refresh trigger=${trigger} payload failed validation — keeping current activeConfig`)
      return false
    }
    setActiveConfig(next)
    console.log(`[prompt-config] refresh trigger=${trigger} OK active version=${next.version} (server-fetched)`)
    return true
  } catch (err) {
    console.log(`[prompt-config] refresh trigger=${trigger} failed: ${(err as Error).message} — keeping current activeConfig`)
    return false
  }
}

// Cheap version-only check used by the polling loop. Hits the lite
// endpoint and only triggers a full refresh when version changed —
// avoids re-downloading the full payload every 5 minutes for no reason.
async function checkVersionDrift(currentVersion: string): Promise<void> {
  const local = loadConfig()
  if (!local.authToken) return
  try {
    const res = await fetch(`${local.serverUrl}/api/companion/config-version`, {
      headers: { Authorization: `Bearer ${local.authToken}` },
    })
    if (!res.ok) return
    const { version } = (await res.json()) as { version?: string }
    if (typeof version === 'string' && version !== currentVersion) {
      console.log(`[prompt-config] poll: drift cached=${currentVersion} server=${version} — refreshing`)
      await refreshPromptConfig('poll-drift')
    } else {
      console.log(`[prompt-config] poll: in sync version=${currentVersion}`)
    }
  } catch {
    // Polling is best-effort. Don't spam logs — the SSE push is the
    // primary channel and that has its own logging.
  }
}

// Starts the 5-minute backup polling loop. Idempotent — safe to call
// multiple times; only one timer ever runs.
export function startPromptConfigPolling(getCurrentVersion: () => string): void {
  if (pollTimer) return
  pollTimer = setInterval(() => {
    void checkVersionDrift(getCurrentVersion())
  }, POLL_INTERVAL_MS)
  // `unref` so the timer doesn't keep the Node process alive on its
  // own. Daemon stays running because of its other listeners; if those
  // all clean up, we don't want this poll holding the process open.
  if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref()
}

// Tears down the polling loop. Useful in tests; not invoked in normal
// daemon lifecycle (the process exit kills the timer anyway).
export function stopPromptConfigPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}
