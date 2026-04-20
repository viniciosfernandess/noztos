// ── Local-Only Compute Layer ────────────────────────────────────────────────
//
// Interfaces for the local compute provider. The Bornastar companion runs
// directly on the user's Mac — no remote sandbox required.
//
// Each repository maps to a local directory. The `sandboxId` field in the
// database stores the absolute path to that directory.

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

  /** Read a file from the sandbox */
  readFile(sandboxId: string, path: string): Promise<string>

  /** Write a file to the sandbox */
  writeFile(sandboxId: string, path: string, content: string): Promise<void>
}
