// Server-side mirror of the daemon's TunnelManager state.
//
// The daemon owns the cloudflared subprocess. Every time it changes
// state (starting → running → stopped/error), it POSTs a frame of
// type 'tunnel_status' to /api/companion/response. We intercept those
// frames there and feed them into setTunnelStatus() below so:
//
//   1. GET /api/tunnel returns the current state synchronously (no
//      round-trip to the daemon needed)
//   2. The navbar button reflects state immediately on mount, even
//      before any SSE frames arrive in this browser tab
//
// In-memory only — local-first, single user, single process. If
// Next.js restarts the daemon will re-broadcast its current state on
// the next status emission (or starting from 'stopped' if the user
// hasn't toggled since).

export type TunnelState =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; url: string; startedAt: number }
  | { state: 'missing-binary'; installHint: string }
  | { state: 'missing-authtoken'; setupHint: string }
  | { state: 'error'; message: string }

let current: TunnelState = { state: 'stopped' }

export function getTunnelState(): TunnelState {
  return current
}

export function setTunnelState(next: TunnelState): void {
  current = next
}
