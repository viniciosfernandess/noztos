// Cached lookup of the installed companion package version. Read once
// at module load from package.json so every heartbeat/register call
// just returns the constant — no disk hit on the hot path.
//
// The path resolution walks up from this file's URL: in production it
// lives at <install_root>/dist/src/daemon-version.js, two `..` away
// from the package root. In dev (ts-node), the same two `..` still
// resolves correctly because tsc preserves the relative layout.
//
// Returns a semver string like "0.1.0", or "unknown" if the file is
// missing or unreadable (defensive — never throws into the daemon
// startup path).

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

let cached: string | null = null

export function getDaemonVersion(): string {
  if (cached) return cached
  try {
    // CommonJS-friendly path resolution (__dirname is a global at
    // runtime in the compiled output). dist/src/ → dist/ → <root>.
    const here = dirname(__filename)
    const pkgPath = resolve(here, '..', '..', 'package.json')
    const raw = readFileSync(pkgPath, 'utf-8')
    const pkg = JSON.parse(raw) as { version?: string }
    cached = typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    cached = 'unknown'
  }
  return cached
}
