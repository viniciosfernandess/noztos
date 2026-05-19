#!/usr/bin/env node
// node-pty ships a `spawn-helper` binary inside its prebuilds folder
// that needs the executable bit set. Some npm versions strip Unix
// permissions when extracting tarballs, leaving spawn-helper as
// `rw-r--r--` and causing posix_spawnp to fail at runtime with no
// useful error. Upstream issue:
//   https://github.com/microsoft/node-pty/issues/581
// Until that fix lands in node-pty's own post-install.js, we walk the
// prebuilds directory and chmod every spawn-helper we find. Idempotent
// and safe to run on Windows (no spawn-helper there).
const fs = require('fs')
const path = require('path')

// When companion/ is installed as part of the root npm workspace,
// node-pty gets hoisted to <repo>/node_modules instead of
// <repo>/companion/node_modules. Check both locations.
const CANDIDATES = [
  path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds'),
  path.join(__dirname, '..', '..', 'node_modules', 'node-pty', 'prebuilds'),
]
const prebuildsRoot = CANDIDATES.find((p) => fs.existsSync(p))

if (!prebuildsRoot) {
  // Fresh install hasn't placed node-pty yet (postinstall sometimes
  // races) — silent no-op. The smoke test in the daemon will surface
  // any remaining issue.
  process.exit(0)
}

let fixed = 0
for (const platform of fs.readdirSync(prebuildsRoot)) {
  const helper = path.join(prebuildsRoot, platform, 'spawn-helper')
  if (!fs.existsSync(helper)) continue
  try {
    fs.chmodSync(helper, 0o755)
    fixed++
  } catch (err) {
    console.warn(`[fix-node-pty-perms] could not chmod ${helper}: ${err.message}`)
  }
}

if (fixed > 0) console.log(`[fix-node-pty-perms] chmod +x on ${fixed} spawn-helper binar${fixed === 1 ? 'y' : 'ies'}`)
