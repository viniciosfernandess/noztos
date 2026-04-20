'use client'

import { useState, useEffect, useCallback } from 'react'

type SetupStep = 'idle' | 'installing' | 'already_installed' | 'installed' | 'login_starting' | 'login_waiting' | 'authenticated' | 'complete' | 'error'

interface LoginInfo {
  url: string | null
  code: string | null
}

interface CompleteInfo {
  email?: string
  plan?: string
  version?: string
}

export function ClaudeSetupModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<SetupStep>('idle')
  const [loginInfo, setLoginInfo] = useState<LoginInfo>({ url: null, code: null })
  const [completeInfo, setCompleteInfo] = useState<CompleteInfo>({})
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const startSetup = useCallback(async () => {
    setStep('installing')
    setError(null)

    // Send setup_claude command to companion
    await fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'setup_claude' }),
    })
  }, [])

  // Listen for setup events via companion stream
  useEffect(() => {
    const controller = new AbortController()

    async function listen() {
      try {
        const res = await fetch('/api/companion/stream', { signal: controller.signal })
        if (!res.ok || !res.body) return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              const event = JSON.parse(line.slice(6))
              const inner = event.type === 'claude_event' ? event.payload?.event : event

              if (inner?.subtype === 'setup_progress') {
                const content = inner.content as string
                if (content === 'installing') setStep('installing')
                else if (content === 'installed' || content === 'already_installed') setStep('installed')
                else if (content === 'authenticated') setStep('authenticated')
                else if (content === 'login_starting') setStep('login_starting')
              }

              if (inner?.subtype === 'login_url') {
                try {
                  const info = JSON.parse(inner.content as string)
                  setLoginInfo({ url: info.url, code: info.code })
                  setStep('login_waiting')
                } catch {}
              }

              if (inner?.subtype === 'setup_complete') {
                try {
                  const info = JSON.parse(inner.content as string)
                  setCompleteInfo(info)
                  setStep('complete')
                } catch {
                  setStep('complete')
                }
              }

              if (event.type === 'error') {
                setError(event.payload?.message ?? 'Setup failed')
                setStep('error')
              }
            } catch {}
          }
        }
      } catch {}
    }

    listen()
    return () => controller.abort()
  }, [])

  // Auto-start setup on mount — small delay to ensure SSE listener is active first
  useEffect(() => {
    const t = setTimeout(() => startSetup(), 500)
    return () => clearTimeout(t)
  }, [startSetup])

  function copyCode() {
    if (loginInfo.code) {
      navigator.clipboard?.writeText(loginInfo.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-sm rounded-xl border border-[#2B2B2B] p-6 shadow-2xl" style={{ backgroundColor: '#1F1F1F' }}>

        {/* Header */}
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/claude-logo.png" alt="Claude" className="h-6 w-6 rounded" />
            <h2 className="text-[15px] font-semibold text-zinc-100">Setup Claude Code</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Steps */}
        <div className="space-y-4">
          {(() => {
            const s = step as string
            const installDone = s !== 'idle' && s !== 'installing'
            const loginDone = s === 'authenticated' || s === 'complete'
            const loginActive = s === 'login_starting' || s === 'login_waiting'
            return (
              <>
          {/* Step 1: Install */}
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
              s === 'installing' ? 'bg-amber-500/10 text-amber-400' :
              installDone ? 'bg-emerald-500/10 text-emerald-400' :
              'bg-zinc-500/10 text-zinc-500'
            }`}>
              {s === 'installing' ? (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" d="M12 3a9 9 0 019 9" />
                </svg>
              ) : installDone ? (
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : '1'}
            </div>
            <div>
              <p className="text-[12px] font-medium text-zinc-200">Install Claude Code</p>
              <p className="text-[10px] text-zinc-500">
                {s === 'installing' ? 'Installing...' : installDone ? 'Installed' : 'Waiting...'}
              </p>
            </div>
          </div>

          {/* Step 2: Login */}
          <div className="flex items-start gap-3">
            <div className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
              loginActive ? 'bg-violet-500/10 text-violet-400' :
              loginDone ? 'bg-emerald-500/10 text-emerald-400' :
              'bg-zinc-500/10 text-zinc-500'
            }`}>
              {loginActive ? (
                <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" d="M12 3a9 9 0 019 9" />
                </svg>
              ) : loginDone ? (
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : '2'}
            </div>
            <div className="flex-1">
              <p className="text-[12px] font-medium text-zinc-200">Authenticate</p>
              {s === 'login_waiting' && loginInfo.url ? (
                <div className="mt-2 space-y-2">
                  <a
                    href={loginInfo.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500"
                  >
                    Open authorization page
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                    </svg>
                  </a>
                  {loginInfo.code && (
                    <div className="flex items-center gap-2 rounded-md border border-[#2B2B2B] px-3 py-2" style={{ backgroundColor: '#151515' }}>
                      <span className="font-mono text-[13px] font-bold tracking-wider text-zinc-100">{loginInfo.code}</span>
                      <button
                        onClick={copyCode}
                        className="ml-auto text-[9px] text-zinc-500 hover:text-zinc-300"
                      >
                        {copied ? '✓' : 'Copy'}
                      </button>
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
                    <span className="text-[10px] text-zinc-500">Waiting for authorization...</span>
                  </div>
                </div>
              ) : (
                <p className="text-[10px] text-zinc-500">
                  {loginDone ? 'Authenticated' :
                   s === 'login_starting' ? 'Starting login...' :
                   'Waiting...'}
                </p>
              )}
            </div>
          </div>

          {/* Complete state */}
          {s === 'complete' && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[14px]">✅</span>
                <span className="text-[12px] font-semibold text-emerald-400">Claude Code ready</span>
              </div>
              {(completeInfo.email || completeInfo.plan) && (
                <p className="mt-1 text-[10px] text-zinc-400">
                  {completeInfo.email && <span>{completeInfo.email}</span>}
                  {completeInfo.plan && <span> · {completeInfo.plan}</span>}
                  {completeInfo.version && <span> · {completeInfo.version?.split(' ')[0]}</span>}
                </p>
              )}
            </div>
          )}

          {/* Error state */}
          {s === 'error' && error && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
              <p className="text-[11px] text-red-400">{error}</p>
              <button
                onClick={startSetup}
                className="mt-2 text-[10px] text-zinc-400 hover:text-zinc-200"
              >
                Try again
              </button>
            </div>
          )}
              </>
            )
          })()}
        </div>

        {/* Footer */}
        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className={`rounded-md px-4 py-1.5 text-[11px] font-medium transition-colors ${
              step === 'complete'
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'border border-[#3A3A3A] text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
            }`}
          >
            {step === 'complete' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
