import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompanionConfig, ProjectConfig } from './types.js'

const CONFIG_DIR = join(homedir(), '.bornastar')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const DEFAULT_SERVER = 'https://noztos.com'

function defaults(): CompanionConfig {
  return {
    version: '0.1.0',
    serverUrl: process.env.BORNASTAR_SERVER ?? DEFAULT_SERVER,
    authToken: null,
    projects: [],
  }
}

export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true })
}

export function loadConfig(): CompanionConfig {
  ensureConfigDir()
  if (!existsSync(CONFIG_FILE)) return defaults()
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8')
    return { ...defaults(), ...JSON.parse(raw) }
  } catch {
    return defaults()
  }
}

export function saveConfig(cfg: CompanionConfig): void {
  ensureConfigDir()
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8')
  chmodSync(CONFIG_FILE, 0o600)
}

export function addProject(project: ProjectConfig): CompanionConfig {
  const cfg = loadConfig()
  const existing = cfg.projects.findIndex((p) => p.path === project.path)
  if (existing >= 0) {
    cfg.projects[existing] = project
  } else {
    cfg.projects.push(project)
  }
  saveConfig(cfg)
  return cfg
}

export function removeProject(path: string): CompanionConfig {
  const cfg = loadConfig()
  cfg.projects = cfg.projects.filter((p) => p.path !== path)
  saveConfig(cfg)
  return cfg
}

export function getProject(path: string): ProjectConfig | undefined {
  return loadConfig().projects.find((p) => p.path === path)
}

// Re-key a project's id without changing path/name/etc. Used by the
// register-time reconciliation: when the server detects a daemon-side
// hex id that doesn't match the DB cuid, it tells the daemon to
// relabel — fs-watcher path and worktrees dir then converge on the
// cuid. Returns true when the relabel landed (project found at the
// old id), false when the project no longer exists.
export function relabelProject(oldId: string, newId: string): boolean {
  const cfg = loadConfig()
  const idx = cfg.projects.findIndex((p) => p.id === oldId)
  if (idx < 0) return false
  if (cfg.projects[idx].id === newId) return true
  cfg.projects[idx] = { ...cfg.projects[idx], id: newId }
  saveConfig(cfg)
  return true
}

export function setAuthToken(token: string): void {
  const cfg = loadConfig()
  cfg.authToken = token
  saveConfig(cfg)
}

export function setServerUrl(url: string): void {
  const cfg = loadConfig()
  cfg.serverUrl = url
  saveConfig(cfg)
}

export { CONFIG_DIR, CONFIG_FILE }
