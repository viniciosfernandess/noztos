import { spawn, ChildProcess, execSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'

// ── Tunnel manager ──────────────────────────────────────────────────
//
// Spawns and supervises an `ngrok http <port>` subprocess that
// exposes the local Next.js dev server to the public internet so the
// user's phone can hit the same UI.
//
// Why ngrok and not Cloudflare quick tunnels:
//   We tried `cloudflared tunnel --url …` first — zero setup, no
//   account. Looked perfect until we discovered Cloudflare quick
//   tunnels don't support WebSocket connections. Next.js dev mode
//   relies on a WS for HMR + parts of React hydration; without it,
//   form `onSubmit` handlers never bind and the login form falls
//   back to a native GET that leaks the password into the URL.
//   ngrok's free tier supports WebSocket end-to-end → React hydrates
//   → JS auth flow works as on localhost.
//
// Setup the user does once:
//   brew install ngrok
//   ngrok config add-authtoken <TOKEN from dash.ngrok.com>
//
// Lifecycle:
//   • start() — verifies the `ngrok` binary is on PATH, spawns
//     `ngrok http <port> --log stdout --log-format json`. Watches
//     stdout for the "started tunnel" line containing the public URL
//     and broadcasts state='running' the moment it arrives. Common
//     failure modes (no authtoken configured, account banned, free
//     tier limit hit) come through as JSON `err=…` lines — we surface
//     them verbatim instead of failing silently.
//   • stop() — SIGTERM, SIGKILL after 3 s.
//   • getStatus() — current state for the GET /api/tunnel route.

// Credentials enforced by ngrok at the tunnel edge (HTTP Basic auth).
// Generated fresh per start() and surfaced to the owner so they can hand
// them to the phone — the URL alone no longer reaches the login page.
export interface TunnelBasicAuth {
  username: string
  password: string
}

export type TunnelState =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; url: string; startedAt: number; basicAuth?: TunnelBasicAuth }
  | { state: 'missing-binary'; installHint: string }
  | { state: 'missing-authtoken'; setupHint: string }
  | { state: 'error'; message: string }

interface NgrokLogLine {
  lvl?: string
  msg?: string
  url?: string
  err?: string
  name?: string
  obj?: string
}

export class TunnelManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private status: TunnelState = { state: 'stopped' }
  private healthyTimer: ReturnType<typeof setTimeout> | null = null
  private basicAuth: TunnelBasicAuth | null = null

  // Generate edge-auth credentials for one tunnel session. Fixed
  // username + high-entropy password so the owner has something short to
  // type as the user and a strong secret as the password. ngrok requires
  // the password be >= 8 chars; base64url(18 bytes) is 24.
  private newBasicAuth(): TunnelBasicAuth {
    return { username: 'phone', password: randomBytes(18).toString('base64url') }
  }

  getStatus(): TunnelState {
    return this.status
  }

  /**
   * Start the tunnel against the given local URL (e.g.
   * `http://localhost:3000`). Idempotent — re-calling while running
   * returns the current status.
   */
  start(localUrl: string): TunnelState {
    if (this.proc) return this.status

    try {
      execSync('which ngrok', { stdio: 'pipe' })
    } catch {
      this.status = {
        state: 'missing-binary',
        installHint: 'brew install ngrok',
      }
      this.emit('status', this.status)
      return this.status
    }

    // Extract the port from the URL. ngrok's `http` subcommand wants a
    // port number, not a full URL.
    const port = (() => {
      try {
        const u = new URL(localUrl)
        return u.port || (u.protocol === 'https:' ? '443' : '80')
      } catch {
        return '3000'
      }
    })()

    this.status = { state: 'starting' }
    this.emit('status', this.status)

    // Gate the tunnel edge with HTTP Basic auth. Without this the random
    // *.ngrok URL is the only secret and anyone who has/guesses it reaches
    // the login page (behind which sits host RCE). ngrok enforces these
    // creds before any request hits localhost:3000.
    this.basicAuth = this.newBasicAuth()

    // --basic-auth user:pass: ngrok challenges every request at the edge
    // --log stdout: route logs to stdout (default is rotating file)
    // --log-format json: parseable JSON lines instead of free-form text
    // --log-level info: includes the "started tunnel" line we look for
    const child = spawn(
      'ngrok',
      [
        'http', port,
        '--basic-auth', `${this.basicAuth.username}:${this.basicAuth.password}`,
        '--log', 'stdout', '--log-format', 'json', '--log-level', 'info',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    this.proc = child

    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      // Each line is a JSON object. Split on newline and parse each.
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('{')) continue
        let entry: NgrokLogLine
        try { entry = JSON.parse(trimmed) as NgrokLogLine } catch { continue }

        // "started tunnel" carries the public URL.
        if (entry.msg === 'started tunnel' && typeof entry.url === 'string') {
          if (this.status.state !== 'running') this.markHealthy(entry.url)
          continue
        }

        // Real errors only — ngrok logs `err: "<nil>"` (Go nil printed
        // as a string) on plenty of INFO lines just to indicate "no
        // error here". Treat err field as informational unless lvl
        // actually says it's an error.
        const isErrorLvl = entry.lvl === 'eror' || entry.lvl === 'error'
        const hasRealErr = entry.err && entry.err !== '<nil>' && entry.err !== 'nil'
        if (isErrorLvl || hasRealErr) {
          const msg = hasRealErr ? entry.err! : (entry.msg ?? 'ngrok error')
          if (msg.toLowerCase().includes('authtoken')) {
            this.status = {
              state: 'missing-authtoken',
              setupHint: 'Sign up at https://dashboard.ngrok.com/signup, copy your authtoken, then: ngrok config add-authtoken <TOKEN>',
            }
          } else {
            this.status = { state: 'error', message: msg }
          }
          this.emit('status', this.status)
        }
      }
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)

    // 30 s safety net — if no URL appears, surface an error so the UI
    // can react instead of spinning forever.
    this.healthyTimer = setTimeout(() => {
      if (this.status.state === 'starting') {
        this.status = {
          state: 'error',
          message: 'No tunnel URL detected after 30s. Run `ngrok http 3000` manually to see the actual error.',
        }
        this.emit('status', this.status)
      }
    }, 30_000)

    child.on('exit', (code, signal) => {
      this.proc = null
      if (this.healthyTimer) {
        clearTimeout(this.healthyTimer)
        this.healthyTimer = null
      }
      // Intentional stop — keep the 'stopped' state we already flipped to.
      if (this.status.state === 'stopped') return
      // ngrok exit codes:
      //   0  = normal stop
      //   1  = generic error (parse output for hints)
      //   2  = invalid args
      // We may already have a more specific status from the log parser;
      // only overwrite when we're still in 'starting' (nothing parsed).
      if (this.status.state === 'starting' || this.status.state === 'running') {
        this.status = {
          state: 'error',
          message: `ngrok exited (code=${code}, signal=${signal})`,
        }
        this.emit('status', this.status)
      }
    })

    return this.status
  }

  private markHealthy(url: string) {
    if (this.healthyTimer) {
      clearTimeout(this.healthyTimer)
      this.healthyTimer = null
    }
    this.status = {
      state: 'running',
      url,
      startedAt: Date.now(),
      basicAuth: this.basicAuth ?? undefined,
    }
    this.emit('status', this.status)
  }

  stop(): TunnelState {
    this.basicAuth = null
    if (!this.proc) {
      this.status = { state: 'stopped' }
      this.emit('status', this.status)
      return this.status
    }
    this.status = { state: 'stopped' }
    const proc = this.proc
    proc.kill('SIGTERM')
    const killTimer = setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill('SIGKILL') } catch { /* already dead */ }
      }
    }, 3_000)
    proc.once('exit', () => clearTimeout(killTimer))
    this.emit('status', this.status)
    return this.status
  }
}
