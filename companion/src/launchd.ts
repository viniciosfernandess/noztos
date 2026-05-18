// macOS launchd agent installer.
//
// `noztos login` calls installAndStart() so the daemon runs in the
// background across logins — the user never has to run `noztos start`
// in a terminal. Non-macOS platforms return false and the caller
// falls back to telling the user to run `noztos start` themselves.

import { writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LABEL = 'com.noztos.companion'
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)

function plistContent(noztosBin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${noztosBin}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/noztos-companion.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/noztos-companion.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`
}

function isLoaded(): boolean {
  const uid = process.getuid?.() ?? 0
  try {
    execSync(`launchctl print gui/${uid}/${LABEL}`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export type LaunchdResult =
  | { ok: true; action: 'installed' | 'reloaded' }
  | { ok: false; reason: 'unsupported' | 'launchctl_failed'; error?: string }

/**
 * Write the plist and start (or restart) the launchd agent. Called
 * from `noztos login` so the daemon comes up automatically — no
 * `noztos start` step.
 */
export function installAndStart(): LaunchdResult {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'unsupported' }
  }

  // argv[1] is the absolute path to the `noztos` bin (npm sets this
  // when the user runs the global command).
  const noztosBin = process.argv[1]

  try {
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    writeFileSync(PLIST_PATH, plistContent(noztosBin))

    const uid = process.getuid?.() ?? 0
    const domain = `gui/${uid}`
    const wasLoaded = isLoaded()

    if (wasLoaded) {
      // Restart so the daemon re-reads ~/.bornastar/config.json and
      // picks up the new auth token.
      execSync(`launchctl kickstart -k ${domain}/${LABEL}`, { stdio: 'pipe' })
      return { ok: true, action: 'reloaded' }
    }
    execSync(`launchctl bootstrap ${domain} ${PLIST_PATH}`, { stdio: 'pipe' })
    return { ok: true, action: 'installed' }
  } catch (err) {
    return {
      ok: false,
      reason: 'launchctl_failed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function uninstall(): boolean {
  if (process.platform !== 'darwin') return false
  if (!existsSync(PLIST_PATH)) return true
  try {
    const uid = process.getuid?.() ?? 0
    try {
      execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: 'pipe' })
    } catch {}
    unlinkSync(PLIST_PATH)
    return true
  } catch {
    return false
  }
}
