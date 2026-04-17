// ── Compute Abstraction Layer ──────────────────────────────────────────────
//
// Abstract interface for sandbox/container management.
// Implementations: E2B (testing), AWS Fargate (production).
//
// Each repository gets its own isolated sandbox with:
//   - Linux filesystem
//   - Terminal access
//   - Persistent state (within session)

export interface SandboxInfo {
  id: string
  status: 'running' | 'stopped'
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ComputeProvider {
  /** Create and start a new sandbox for a repository */
  createSandbox(repoUrl?: string): Promise<SandboxInfo>

  /** Execute a command in the sandbox */
  exec(sandboxId: string, command: string): Promise<ExecResult>

  /** Stop/destroy a sandbox */
  stopSandbox(sandboxId: string): Promise<void>

  /** Check if a sandbox is still running */
  isRunning(sandboxId: string): Promise<boolean>

  /** Get the filesystem of a sandbox (list files) */
  listFiles(sandboxId: string, path: string): Promise<string[]>

  /** Read a file from the sandbox */
  readFile(sandboxId: string, path: string): Promise<string>

  /** Write a file to the sandbox */
  writeFile(sandboxId: string, path: string, content: string): Promise<void>
}

// Active provider — swap between Local, E2B, and AWS based on
// BORNASTAR_MODE env var. Defaults to 'local' for companion-first
// development. Set to 'cloud' to use E2B sandboxes.
let activeProvider: ComputeProvider | null = null

export function setComputeProvider(provider: ComputeProvider) {
  activeProvider = provider
}

export function getComputeProvider(): ComputeProvider {
  if (!activeProvider) throw new Error('No compute provider configured. Call setComputeProvider() first.')
  return activeProvider
}

export function isLocalMode(): boolean {
  return (process.env.BORNASTAR_MODE ?? 'local') === 'local'
}

export async function getDefaultProvider(): Promise<ComputeProvider> {
  if (isLocalMode()) {
    const { LocalProvider } = await import('./compute-local')
    return new LocalProvider()
  }
  const { E2BProvider } = await import('./compute-e2b')
  return new E2BProvider()
}
