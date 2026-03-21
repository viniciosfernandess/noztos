'use client'

import { useState, useRef, useEffect } from 'react'

interface Message {
  id: string
  content: string
  sender: string
  createdAt: string
}

interface ChatSectionProps {
  projectId: string
  initialMessages: Message[]
}

export function ChatSection({ projectId, initialMessages }: ChatSectionProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const content = input.trim()
    if (!content || sending) return

    setInput('')
    setSending(true)

    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })

      if (res.ok) {
        const { userMessage, aiMessage } = await res.json()
        setMessages((prev) => [...prev, userMessage, aiMessage])
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="flex flex-col rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <div className="border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Chat
        </h2>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto px-6 py-4" style={{ maxHeight: '400px' }}>
        {messages.length === 0 && (
          <p className="text-sm text-zinc-400 text-center py-8">
            No messages yet. Start a conversation with your AI team.
          </p>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                msg.sender === 'user'
                  ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                  : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
              }`}
            >
              {msg.sender !== 'user' && (
                <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  {msg.sender}
                </span>
              )}
              <p className="whitespace-pre-wrap">{msg.content}</p>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={sendMessage}
        className="flex items-center gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message your AI team..."
          disabled={sending}
          className="flex-1 h-9 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="flex h-9 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {sending ? '...' : 'Send'}
        </button>
      </form>
    </section>
  )
}
