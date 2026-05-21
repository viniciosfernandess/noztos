// gstack skill discovery.
//
// noztos surfaces gstack skills the user already has installed inside
// the chat `/` selector. We never bundle or install gstack — this is a
// pure local read of ~/.claude/skills/, the standard Claude Code skill
// directory. gstack installs each of its skills as a top-level entry
// there (a symlink into its repo folder ~/.claude/skills/gstack/).
//
// This runs server-side only. noztos is local-first — the Next.js
// server is on the user's own machine, so it can read ~/.claude/
// directly; no daemon round-trip needed.
//
// A gstack skill is invoked natively by the claude CLI via /<name>.
// noztos only needs the name + description here to list them in the
// selector — it does NOT read or inject the skill body. The CLI owns
// execution: sending `/<name>` in the chat is enough.

import { homedir } from 'node:os'
import { existsSync, readdirSync, realpathSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'

export interface GstackSkill {
  // The slash invocation — e.g. "ship" means the user runs /ship.
  // This is the entry name in ~/.claude/skills/, which is exactly
  // what the claude CLI resolves.
  invocation: string
  // Display name from SKILL.md frontmatter; falls back to invocation.
  name: string
  // One-line description from SKILL.md frontmatter; may be empty.
  description: string
}

// Pull `name:` / `description:` out of a SKILL.md YAML frontmatter
// block. Claude Code skill frontmatter keeps each on a single line,
// so a line-based parse is enough — no YAML dependency for two fields.
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const trimmed = md.trimStart()
  if (!trimmed.startsWith('---')) return {}
  const end = trimmed.indexOf('\n---', 3)
  if (end === -1) return {}
  const block = trimmed.slice(3, end)
  const out: { name?: string; description?: string } = {}
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    let val = line.slice(colon + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key === 'name' && val) out.name = val
    else if (key === 'description' && val) out.description = val
  }
  return out
}

// Scan ~/.claude/skills/ for skills that live inside a `gstack` folder.
// A skill qualifies when its symlink-resolved real path has a parent
// directory literally named `gstack` and contains a SKILL.md. This is
// location-tolerant: wherever the gstack repo sits, any skill whose
// parent dir is `gstack` is picked up. Returns [] for any failure
// (missing dir, unreadable entry) — the selector then shows no gstack
// group, which is the correct behaviour for a machine without gstack.
export function discoverGstackSkills(): GstackSkill[] {
  try {
    const skillsDir = join(homedir(), '.claude', 'skills')
    if (!existsSync(skillsDir)) return []

    const skills: GstackSkill[] = []
    for (const entry of readdirSync(skillsDir)) {
      try {
        const real = realpathSync(join(skillsDir, entry))
        if (!statSync(real).isDirectory()) continue
        // Belongs to gstack only if the parent dir is named `gstack`.
        if (basename(dirname(real)) !== 'gstack') continue
        const skillMd = join(real, 'SKILL.md')
        if (!existsSync(skillMd)) continue
        const fm = parseFrontmatter(readFileSync(skillMd, 'utf-8'))
        skills.push({
          invocation: entry,
          name: fm.name || entry,
          description: fm.description || '',
        })
      } catch {
        // A broken symlink or unreadable entry shouldn't abort the
        // whole scan — skip just this one.
      }
    }
    skills.sort((a, b) => a.invocation.localeCompare(b.invocation))
    return skills
  } catch {
    return []
  }
}
