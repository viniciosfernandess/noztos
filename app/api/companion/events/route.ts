import { NextRequest } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel } from '@/lib/companion-relay'

// GET — SSE stream that the companion daemon listens to. When the
// browser sends a command (via POST /api/companion/command), the
// relay pushes it through this stream so the companion picks it up.
//
// The companion keeps this connection open permanently. If it drops,
// the daemon reconnects automatically (built into daemon.ts).
export async function GET(request: NextRequest) {
  const auth = await verifyAuth(request)
  if (!auth) {
    return new Response('Unauthorized', { status: 401 })
  }

  const channel = getChannel(auth.userId)

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()

      function send(data: unknown) {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {
          // Stream closed
        }
      }

      // Drain any queued commands first
      for (const cmd of channel.drainCommands()) {
        send(cmd)
      }

      // Listen for new commands
      function onCommand(cmd: unknown) {
        send(cmd)
      }
      channel.commandEmitter.on('command', onCommand)

      // Heartbeat every 20s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
          channel.heartbeat()
        } catch {
          clearInterval(heartbeat)
        }
      }, 20_000)

      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        channel.commandEmitter.off('command', onCommand)
        clearInterval(heartbeat)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
