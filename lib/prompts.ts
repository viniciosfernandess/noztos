import { readFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { prisma } from '@/lib/db'

// ── Prompt Loader ─────────────────────────────────────────────────────────
//
// Behavior rules (base, build, task, modes) are loaded from /prompts/*.md
// files. Skill prompts (per-agent system prompts like CEO, Architect,
// Tester...) live in the DB on Collaborator.skillMd — see the skill
// cache section below for why the file-backed loader stops at skills.

const PROMPTS_DIR = join(process.cwd(), 'prompts')

// Cache prompts in memory (they don't change at runtime)
const cache = new Map<string, string>()

function load(filePath: string): string {
  if (cache.has(filePath)) return cache.get(filePath)!
  const content = readFileSync(filePath, 'utf-8')
  cache.set(filePath, content)
  return content
}

// ── Base Prompts ──────────────────────────────────────────────────────────

export function getBasePrompt(): string {
  return load(join(PROMPTS_DIR, 'base.md'))
}

export function getSuggestionsRules(): string {
  return load(join(PROMPTS_DIR, 'suggestions-rules.md'))
}

// ── Skill Prompts (DB-backed) ─────────────────────────────────────────────
//
// Each agent's system prompt lives on Collaborator.skillMd in Postgres.
// We pull all platform defaults once on the first miss and keep them in
// process memory thereafter. Cache key is the lowercase agent name
// (matches the UI ids: 'ceo', 'tester', 'docs'…). Hits cost a Map.get,
// so callers see the same latency they had with the previous filesystem
// loader.
//
// Invalidation is explicit: callers that mutate a row (PATCH, seed
// re-run) should call invalidateSkillCache(name) to drop the entry, and
// the next read pulls fresh. We don't TTL — skill prompts are stable
// platform-wide and a stale cache for hours is worse only when an admin
// edits one, which is rare and they can trigger refresh.

interface SkillCacheEntry {
  content: string
  displayName: string
}

const skillCache = new Map<string, SkillCacheEntry>()
let skillCacheLoaded = false
let skillCacheLoadPromise: Promise<void> | null = null

export async function ensureSkillCacheLoaded(): Promise<void> {
  if (skillCacheLoaded) return
  // Coalesce concurrent first-misses behind a single DB query —
  // serverless cold starts hit this from N parallel chat requests.
  if (skillCacheLoadPromise) return skillCacheLoadPromise
  skillCacheLoadPromise = (async () => {
    const t0 = Date.now()
    const all = await prisma.collaborator.findMany({
      where: { isPlatformDefault: true, projectId: null },
      select: { name: true, skillMd: true },
    })
    for (const c of all) {
      skillCache.set(c.name.toLowerCase(), { content: c.skillMd, displayName: c.name })
    }
    skillCacheLoaded = true
    skillCacheLoadPromise = null
    console.log(`[skill-cache] loaded ${all.length} platform defaults from DB in ${Date.now() - t0}ms (names=${all.map((c) => c.name).join(', ')})`)
  })()
  return skillCacheLoadPromise
}

/**
 * Returns the skillMd for the given skillId (case-insensitive). Throws
 * if the agent is not a platform default — callers should treat that as
 * a bug, not a runtime fallback.
 */
export async function getSkillPrompt(skillId: string): Promise<string> {
  await ensureSkillCacheLoaded()
  const hit = skillCache.get(skillId.toLowerCase())
  if (!hit) throw new Error(`Unknown skill: ${skillId}`)
  return hit.content
}

/**
 * Display name for an agent ('ceo' → 'CEO', 'devops' → 'DevOps'). Used
 * by task logs / UI labels. Falls back to 'Claude' for unknown ids
 * (matches the previous SKILL_NAMES behaviour).
 */
export async function getSkillName(skillId: string): Promise<string> {
  await ensureSkillCacheLoaded()
  return skillCache.get(skillId.toLowerCase())?.displayName ?? 'Claude'
}

/**
 * Returns the full set of platform-default skill prompts plus a version
 * tag the daemon can compare for drift detection. The version is a SHA-
 * 256 hash of the concatenated (name, prompt) tuples — any edit to any
 * skill flips the hash automatically, so we don't need a separate
 * version column or a manual bump on the admin side.
 *
 * Used by the companion daemon to mirror the CompanionConfig flow:
 *   1. fetch on startup → cache in RAM
 *   2. SSE 'skills_updated' push → refetch
 *   3. 5-min poll on /skills-version → refetch when hash drifts
 */
export async function loadAllSkillsForDaemon(): Promise<{
  skills: Array<{ name: string; prompt: string }>
  version: string
}> {
  await ensureSkillCacheLoaded()
  // Iterate the cache in stable name order so the hash is deterministic
  // across processes — two daemons fetching the same DB state must see
  // the same version string.
  const entries = Array.from(skillCache.values()).sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )
  const skills = entries.map((e) => ({ name: e.displayName, prompt: e.content }))
  const hash = createHash('sha256')
  for (const s of skills) {
    hash.update(s.name)
    hash.update('\0')
    hash.update(s.prompt)
    hash.update('\0')
  }
  const version = hash.digest('hex').slice(0, 16)
  return { skills, version }
}

/**
 * Drops cached entries so the next read pulls fresh from the DB.
 * Pass a name to invalidate just one agent (case-insensitive) or omit
 * to wipe everything. Call this from any handler that mutates skillMd.
 */
export function invalidateSkillCache(name?: string): void {
  if (name) {
    skillCache.delete(name.toLowerCase())
  } else {
    skillCache.clear()
    skillCacheLoaded = false
  }
}

// ── Specialty Prompts ─────────────────────────────────────────────────────

export function getSecurityScanPrompt(mode: 'full' | 'targeted'): string {
  return load(join(PROMPTS_DIR, `security-scan-${mode}.md`))
}

export function getCodeHealthPrompt(mode: 'full' | 'targeted'): string {
  return load(join(PROMPTS_DIR, `codehealth-${mode}.md`))
}

// ── Task Prompts ──────────────────────────────────────────────────────────

/** System prompt for task execution (skill mode — single agent runs alone) */
export async function buildTaskSkillPrompt(skillId: string): Promise<string> {
  const skillMd = await getSkillPrompt(skillId)
  return [getBasePrompt(), skillMd, getSuggestionsRules()].join('\n\n---\n\n')
}

/** System prompt for task execution (team pipeline — non-builder member) */
export async function buildTaskTeamMemberPrompt(skillId: string): Promise<string> {
  const skillMd = await getSkillPrompt(skillId)
  return [getBasePrompt(), skillMd, getSuggestionsRules()].join('\n\n---\n\n')
}

/** System prompt for task execution (team pipeline — builder step) */
export async function buildTaskBuilderPrompt(): Promise<string> {
  const skillMd = await getSkillPrompt('builder')
  return [getBasePrompt(), skillMd, getSuggestionsRules()].join('\n\n---\n\n')
}

