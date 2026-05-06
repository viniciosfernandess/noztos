import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { loadAllSkillsForDaemon } from '@/lib/prompts'

// GET — companion daemon fetches the active platform-default skill
// prompts (CEO, Architect, Tester, Builder, …) and caches them in RAM
// alongside its CompanionConfig modePrompts. This is what makes
// `/ceo`-style chat slash commands inject the right system prompt
// without ever touching the user's disk.
//
// Mirrors /api/companion/config exactly:
//   • auth via daemon Bearer token (anonymous = 401)
//   • returns { skills: [{name, prompt}], version: <16-char hash> }
//   • version is derived from the prompt content itself (sha256), so
//     any edit to any skillMd row flips the version automatically —
//     the daemon's poll/SSE-push flow just works.
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const payload = await loadAllSkillsForDaemon()
  console.log(`[api/skills] daemon fetched skills version=${payload.version} count=${payload.skills.length}`)
  return NextResponse.json(payload)
}
