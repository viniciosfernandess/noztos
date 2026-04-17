import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeAuthInfo } from './types.js'

const CLAUDE_CONFIG_DIR = join(homedir(), '.claude')
const CREDENTIALS_FILE = join(CLAUDE_CONFIG_DIR, '.credentials.json')

export function detectClaudeInstallation(): boolean {
  try {
    const result = execSync('which claude 2>/dev/null', { encoding: 'utf-8' }).trim()
    return result.length > 0
  } catch {
    return false
  }
}

export function getClaudeVersion(): string | null {
  try {
    return execSync('claude --version 2>/dev/null', { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

export function detectClaudeAuth(): ClaudeAuthInfo {
  const installed = detectClaudeInstallation()
  if (!installed) {
    return {
      installed: false,
      authenticated: false,
      error: 'Claude Code is not installed. Install it: curl -fsSL https://claude.ai/install.sh | bash',
    }
  }

  // Check credentials file on Linux/WSL
  if (existsSync(CREDENTIALS_FILE)) {
    try {
      const raw = readFileSync(CREDENTIALS_FILE, 'utf-8')
      const creds = JSON.parse(raw)
      if (creds.claudeAiOauth?.accessToken) {
        return {
          installed: true,
          authenticated: true,
          email: creds.claudeAiOauth?.email,
          plan: creds.claudeAiOauth?.plan,
        }
      }
    } catch {
      // Fall through to CLI check
    }
  }

  // Use `claude auth status` for definitive check (works on macOS Keychain too)
  try {
    const output = execSync('claude auth status 2>&1', {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()

    // Parse output for auth info
    const authenticated = !output.toLowerCase().includes('not logged in')
      && !output.toLowerCase().includes('no auth')
      && output.length > 0

    let email: string | undefined
    let plan: string | undefined
    const emailMatch = output.match(/email[:\s]+([^\s]+@[^\s]+)/i)
    if (emailMatch) email = emailMatch[1]
    const planMatch = output.match(/(pro|max|team|enterprise)/i)
    if (planMatch) plan = planMatch[1].toLowerCase()

    return { installed: true, authenticated, email, plan }
  } catch {
    return {
      installed: true,
      authenticated: false,
      error: 'Could not determine auth status. Run `claude login` to authenticate.',
    }
  }
}

export function getClaudeInfo(): { version: string | null; auth: ClaudeAuthInfo } {
  return {
    version: getClaudeVersion(),
    auth: detectClaudeAuth(),
  }
}
