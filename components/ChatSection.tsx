'use client'

import { useState, useRef, useEffect } from 'react'

type PermissionMode = 'leitura' | 'planejamento' | 'edicao'

const MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'leitura', label: 'Ask', description: 'Read and analyze only' },
  { value: 'planejamento', label: 'Plan', description: 'Plan without executing' },
  { value: 'edicao', label: 'Agent', description: 'Full access' },
]

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

interface PendingPermission {
  reason: string
  originalContent: string
}

export function ChatSection({ projectId, initialMessages }: ChatSectionProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('leitura')
  const [pendingPermission, setPendingPermission] = useState<PendingPermission | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function doSend(content: string, mode: PermissionMode) {
    setSending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, permissionMode: mode }),
      })

      if (res.ok) {
        const data = await res.json()
        const newMessages = [data.userMessage, ...(data.replies ?? [])].filter(Boolean)
        setMessages((prev) => [...prev, ...newMessages])

        if (data.permissionRequired) {
          setPendingPermission({ reason: data.permissionReason ?? 'make changes', originalContent: content })
        }
      }
    } finally {
      setSending(false)
    }
  }

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    const content = input.trim()
    if (!content || sending) return
    setInput('')
    await doSend(content, permissionMode)
  }

  async function approvePermission() {
    if (!pendingPermission) return
    const original = pendingPermission.originalContent
    setPendingPermission(null)
    setPermissionMode('edicao')
    await doSend(original, 'edicao')
  }

  function denyPermission() {
    setPendingPermission(null)
  }

  return (
    <section className="relative flex flex-col rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">

      {/* Permission modal */}
      {pendingPermission && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Permission required</p>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{pendingPermission.reason}</p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={approvePermission}
                className="flex-1 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Switch to Agent
              </button>
              <button
                onClick={denyPermission}
                className="flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
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
        {messages.map((msg) => {
          // Step messages — tool calls and file changes shown inline
          if (msg.sender === 'step') {
            let label = msg.content
            try {
              const parsed = JSON.parse(msg.content)
              if (parsed.label) label = parsed.label
              else if (parsed.path) label = `${parsed.action === 'delete_file' ? 'Deleted' : 'Changed'} \`${parsed.path}\``
            } catch { /* use raw content */ }
            return (
              <div key={msg.id} className="flex justify-start">
                <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono pl-1">{label}</span>
              </div>
            )
          }

          return (
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
          )
        })}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={sendMessage}
        className="flex flex-col gap-2 border-t border-zinc-200 px-4 pb-3 pt-3 dark:border-zinc-800"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message your AI team..."
          disabled={sending}
          className="h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />
        <div className="flex items-center justify-between">
          {/* Mode selector */}
          <div className="flex items-center gap-1">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setPermissionMode(m.value)}
                title={m.description}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  permissionMode === m.value
                    ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="flex h-8 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
        >
          {sending ? '...' : 'Send'}
        </button>
        </div>
      </form>
    </section>
  )
}
