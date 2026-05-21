import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { discoverGstackSkills } from '@/lib/gstack-skills'

interface RouteContext {
  params: Promise<{ id: string }>
}

// GET — List gstack skills installed on this machine.
//
// Scoped under a project only to reuse verifyProjectAccess for auth;
// the result is machine-global (gstack lives in ~/.claude/skills/),
// not project-specific. Returns { skills: [] } when gstack isn't
// installed — the chat selector then shows no gstack group.
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const access = await verifyProjectAccess(id)
  if ('error' in access) {
    return NextResponse.json({ error: access.error }, { status: access.status })
  }
  return NextResponse.json({ skills: discoverGstackSkills() })
}
