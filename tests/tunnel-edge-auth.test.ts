import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture the args ngrok is spawned with so we can assert the tunnel edge
// is gated with HTTP Basic auth.
const spawnCalls: Array<{ cmd: string; args: string[] }> = []

vi.mock('node:child_process', () => {
  return {
    // `which ngrok` — pretend the binary exists.
    execSync: vi.fn(() => Buffer.from('/usr/local/bin/ngrok')),
    spawn: vi.fn((cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args })
      // Minimal ChildProcess stub: stdout/stderr with .on, plus .on/.kill.
      const noopStream = { on: vi.fn() }
      return {
        stdout: noopStream,
        stderr: noopStream,
        on: vi.fn(),
        once: vi.fn(),
        kill: vi.fn(),
        killed: false,
      }
    }),
  }
})

describe('companion tunnel edge auth', () => {
  beforeEach(() => {
    spawnCalls.length = 0
  })

  it('spawns ngrok with --basic-auth and generated creds', async () => {
    const { TunnelManager } = await import('../companion/src/tunnel-manager')
    const mgr = new TunnelManager()
    mgr.start('http://localhost:3000')

    expect(spawnCalls).toHaveLength(1)
    const { cmd, args } = spawnCalls[0]
    expect(cmd).toBe('ngrok')

    const flagIdx = args.indexOf('--basic-auth')
    expect(flagIdx).toBeGreaterThan(-1)

    const creds = args[flagIdx + 1]
    expect(creds).toMatch(/^phone:.+/)
    const password = creds.split(':')[1]
    // ngrok requires >= 8 chars; our generated secret is much longer.
    expect(password.length).toBeGreaterThanOrEqual(8)
  })

  it('regenerates a different password on each start', async () => {
    const { TunnelManager } = await import('../companion/src/tunnel-manager')
    const a = new TunnelManager()
    a.start('http://localhost:3000')
    const b = new TunnelManager()
    b.start('http://localhost:3000')

    const credsA = spawnCalls[0].args[spawnCalls[0].args.indexOf('--basic-auth') + 1]
    const credsB = spawnCalls[1].args[spawnCalls[1].args.indexOf('--basic-auth') + 1]
    expect(credsA).not.toBe(credsB)
  })
})
