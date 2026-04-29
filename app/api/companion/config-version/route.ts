import { NextRequest, NextResponse } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

// GET — lite version-only endpoint the companion polls every 5min as
// a backup channel against the SSE 'config_updated' push. ~30 byte
// response, designed to be cheap. Companion compares to its cached
// version — if mismatched, it calls the full /config endpoint.
//
// SSE push is the primary mechanism; this exists in case SSE silently
// dropped a reconnect and the daemon wouldn't otherwise know.
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const config = await prisma.companionConfig.findUnique({
    where: { id: 'singleton' },
    select: { version: true },
  })
  if (!config) return NextResponse.json({ error: 'No config row yet' }, { status: 404 })

  return NextResponse.json({ version: config.version })
}
