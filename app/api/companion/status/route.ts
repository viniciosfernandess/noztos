import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getCompanionStatus } from '@/lib/companion-relay'

// GET — Check if the user's companion daemon is connected.
// Browser polls this (or checks once on load) to decide whether to
// show "Companion connected ✅" or "Install companion → bornastar start".
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const status = getCompanionStatus(auth.userId)
  return NextResponse.json(status)
}
