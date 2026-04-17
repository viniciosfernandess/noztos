import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CompanionConfig, ProjectConfig } from './types.js'

const CONFIG_DIR = join(homedir(), '.bornastar')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const DEFAULT_SERVER = 'https://bornastar.com'

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
