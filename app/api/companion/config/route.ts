import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

// GET — companion daemon fetches the active prompt config and caches
// it in RAM for the life of the process. See model docstring on
// CompanionConfig in prisma/schema.prisma for full rationale; in
// short, this is what lets us iterate on system prompts without
// shipping daemon updates to users.
//
// Auth via companion token (same as every other companion endpoint).
// Anonymous requests are rejected — we don't expose prompts publicly.
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const config = await prisma.companionConfig.findUnique({
    where: { id: 'singleton' },
  })
  if (!config) {
    // No row yet — daemon will fall back to its bundled defaults. We
    // return 404 so the daemon knows to keep its current cache
    // (whether bundled or last server fetch). Different from 500 so
    // the daemon doesn't treat it as a transient error worth retrying.
    return NextResponse.json({ error: 'No config row yet' }, { status: 404 })
  }

  return NextResponse.json({
    modePrompts: config.modePrompts,
    namingRule: config.namingRule,
    disallowedTools: config.disallowedTools,
    version: config.version,
  })
}
