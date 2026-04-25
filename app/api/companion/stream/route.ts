import { NextRequest } from 'next/server'
import { verifyAuth } from '@/lib/auth'
import { getChannel } from '@/lib/companion-relay'

// GET — SSE stream that the browser listens to. Claude Code events
// from the companion are relayed here in real-time. The chat UI
// subscribes to this stream to render assistant messages, tool calls,
// and results as they arrive.
//
// This is the local-mode equivalent of the old chat SSE endpoint
// that streamed Bornastar Engine responses.
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

      // Send connection status first
      send({
        type: 'companion_status',
        connected: channel.isCompanionConnected(),
        authInfo: channel.companion?.authInfo,
        projects: channel.companion?.projects,
        machineName: channel.companion?.machineName,
      })

      // Drain queued events
      for (const evt of channel.drainEvents()) {
        send(evt)
      }

      // Listen for new events from companion
      function onEvent(evt: unknown) {
        send(evt)
      }
      channel.eventEmitter.on('event', onEvent)

      // Heartbeat every 20s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, 20_000)

      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        channel.eventEmitter.off('event', onEvent)
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
