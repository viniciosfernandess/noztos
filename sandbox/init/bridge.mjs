// Cloud Mirror — in-sandbox claude bridge.
//
// Runs inside the E2B sandbox after init.sh finishes materialising the
// worktree. Acts as the minimal subset of the local companion daemon
// needed for cloud-side execution:
//
//   1. Subscribe to /api/companion/events SSE stream using the sandbox
//      session token. The server routes prompts for this worktree to
//      this connection (instead of the user's local daemon) once
//      WorktreeMirror has an active SandboxSession.
//
//   2. For each `prompt` command received, spawn `claude` in /workspace
//      with the user-selected mode/model. The sandbox uses
//      ANTHROPIC_API_KEY (Bornastar's billed key) — there is no OAuth
//      portability from the user's Mac.
//
//   3. Pipe claude's stream-json stdout into /api/companion/response
//      one event at a time. The server fan-outs to the browser via its
//      existing SSE relay, so the user's chat scrolls naturally
//      regardless of where claude is actually running.
//
// This script is intentionally minimal — the rich features of the
// local daemon (multi-bridge, PTY shells, sync queue, persistence
// fallback) are NOT present here. The sandbox is short-lived, single-
// worktree, and the server's SQLite queue + write-through already cover
// durability for chat messages. If a sandbox dies mid-stream, the user
// just sees the partial response and can retry — same as today's
// local-side flow.

import { spawn } from 'node:child_process'
import process from 'node:process'

const SERVER = process.env.BORNASTAR_SERVER_URL
const TOKEN = process.env.BORNASTAR_SANDBOX_TOKEN
const WORKTREE_ID = process.env.BORNASTAR_WORKTREE_ID
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY

if (!SERVER || !TOKEN || !WORKTREE_ID || !ANTHROPIC_KEY) {
  console.error('[bridge] missing required env vars; refusing to start')
  process.exit(1)
}

const AUTH_HEADER = { Authorization: `Bearer ${TOKEN}` }

let activeChild = null

async function post(path, body) {
  try {
    const res = await fetch(`${SERVER}${path}`, {
      method: 'POST',
      headers: { ...AUTH_HEADER, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return res
  } catch (err) {
    console.warn(`[bridge] POST ${path} failed:`, err)
    return null
  }
}

async function sendEvent(event, bornastarSessionId) {
  await post('/api/companion/response', {
    event,
    payload: { worktreeId: WORKTREE_ID, bornastarSessionId, source: 'cloud' },
  })
}

function runClaude(cmd) {
  if (activeChild) {
    console.warn('[bridge] claude already running — interrupting before new prompt')
    try { activeChild.kill('SIGINT') } catch {}
    activeChild = null
  }

  const args = ['-p', cmd.prompt, '--output-format', 'stream-json', '--verbose']
  if (cmd.sessionId) args.push('--resume', cmd.sessionId)
  if (cmd.mode) args.push('--permission-mode', cmd.mode)
  if (cmd.model) args.push('--model', cmd.model)

  console.log(`[bridge] claude spawn mode=${cmd.mode ?? 'agent'} model=${cmd.model ?? 'default'} resume=${cmd.sessionId?.slice(0, 8) ?? 'new'}`)

  const child = spawn('claude', args, {
    cwd: '/workspace',
    env: { ...process.env, ANTHROPIC_API_KEY: ANTHROPIC_KEY },
  })
  activeChild = child

  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf-8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        sendEvent(event, cmd.bornastarSessionId)
      } catch {
        sendEvent({ type: 'system', content: trimmed }, cmd.bornastarSessionId)
      }
    }
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf-8').trim()
    if (text) console.warn(`[bridge] claude stderr: ${text}`)
  })

  child.on('close', (code) => {
    if (buffer.trim()) {
      try { sendEvent(JSON.parse(buffer.trim()), cmd.bornastarSessionId) }
      catch { sendEvent({ type: 'system', content: buffer.trim() }, cmd.bornastarSessionId) }
    }
    if (activeChild === child) activeChild = null
    console.log(`[bridge] claude exit code=${code}`)
  })

  child.on('error', (err) => {
    console.error('[bridge] claude spawn error:', err)
    if (activeChild === child) activeChild = null
  })
}

async function consumeEventStream() {
  // Re-subscribe with exponential backoff if the SSE connection drops.
  // The server pushes a heartbeat every ~30s so a dead connection is
  // detected quickly.
  let backoff = 500
  while (true) {
    try {
      const res = await fetch(`${SERVER}/api/companion/events?cloud=1&worktreeId=${WORKTREE_ID}`, {
        headers: AUTH_HEADER,
      })
      if (!res.ok || !res.body) {
        throw new Error(`events stream HTTP ${res.status}`)
      }
      backoff = 500 // reset on successful connect

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const payload = line.slice('data: '.length).trim()
          if (!payload || payload === '[heartbeat]') continue
          try {
            const msg = JSON.parse(payload)
            if (msg.type === 'prompt' && msg.payload?.worktreeId === WORKTREE_ID) {
              runClaude(msg.payload)
            } else if (msg.type === 'interrupt') {
              if (activeChild) {
                try { activeChild.kill('SIGINT') } catch {}
              }
            }
          } catch (err) {
            console.warn('[bridge] event parse error:', err)
          }
        }
      }
    } catch (err) {
      console.warn(`[bridge] event stream broke (${err}); reconnect in ${backoff}ms`)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
}

console.log(`[bridge] starting for worktree=${WORKTREE_ID}`)
consumeEventStream().catch((err) => {
  console.error('[bridge] fatal:', err)
  process.exit(1)
})
