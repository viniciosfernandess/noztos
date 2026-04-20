'use client'

import { useState, useEffect, useCallback } from 'react'

export function CompanionSetup() {
  const [token, setToken] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [copied, setCopied] = useState<'install' | 'login' | 'start' | null>(null)
  const [companionStatus, setCompanionStatus] = useState<'waiting' | 'connected'>('waiting')

  const generateToken = useCallback(async () => {
    setGenerating(true)
    try {
      // Revoke any existing tokens first — always 1 token at a time
      const list = await fetch('/api/companion/tokens').then(r => r.json())
      for (const t of list.tokens ?? []) {
        await fetch('/api/companion/tokens', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: t.id }),
        })
      }
      const res = await fetch('/api/companion/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'CLI Setup' }),
      })
      const data = await res.json()
      if (data.token) setToken(data.token)
    } catch {}
    setGenerating(false)
  }, [])

  useEffect(() => {
    if (!token) return
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/companion/status')
        const data = await res.json()
        if (data.connected) {
          setCompanionStatus('connected')
          clearInterval(interval)
          setTimeout(() => window.location.reload(), 1500)
        }
      } catch {}
    }, 3000)
    return () => clearInterval(interval)
  }, [token])

  function copyToClipboard(text: string, id: 'install' | 'login' | 'start') {
    navigator.clipboard?.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="w-full max-w-md">

        <div className="mb-6 text-center">
          <h1 className="text-[17px] font-semibold text-zinc-100">Get started with Bornastar</h1>
          <p className="mt-1 text-[12px] text-zinc-500">
            Install the CLI on your computer to start coding
          </p>
        </div>

        <div className="space-y-3">

          {/* Step 1 */}
          <div className="rounded-lg border border-[#2B2B2B] px-4 py-3" style={{ backgroundColor: '#1F1F1F' }}>
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-[10px] font-bold text-emerald-400">1</span>
              <span className="text-[12px] font-medium text-zinc-300">Install the Bornastar CLI</span>
            </div>
            <div className="group relative">
              <pre className="rounded-md border border-[#2B2B2B] px-3 py-2 font-mono text-[11px] text-emerald-300/80" style={{ backgroundColor: '#151515' }}>
                curl -fsSL https://bornastar.com/install.sh | bash
              </pre>
              <button
                onClick={() => copyToClipboard('curl -fsSL https://bornastar.com/install.sh | bash', 'install')}
                className="absolute right-1.5 top-1.5 rounded border border-[#3A3A3A] px-1.5 py-0.5 text-[9px] text-zinc-500 opacity-0 transition-opacity hover:bg-white/5 hover:text-zinc-300 group-hover:opacity-100"
              >
                {copied === 'install' ? '✓' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Step 2 */}
          <div className="rounded-lg border border-[#2B2B2B] px-4 py-3" style={{ backgroundColor: '#1F1F1F' }}>
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/10 text-[10px] font-bold text-violet-400">2</span>
              <span className="text-[12px] font-medium text-zinc-300">Authenticate</span>
            </div>
            {!token ? (
              <button
                onClick={generateToken}
                disabled={generating}
                className="w-full rounded-md bg-violet-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
              >
                {generating ? 'Generating...' : 'Generate Token'}
              </button>
            ) : (
              <div className="space-y-2">
                <div className="group relative">
                  <pre className="rounded-md border border-[#2B2B2B] px-3 py-2 font-mono text-[11px] text-violet-300/80 break-all whitespace-pre-wrap" style={{ backgroundColor: '#151515' }}>
                    bornastar login {token}
                  </pre>
                  <button
                    onClick={() => copyToClipboard(`bornastar login ${token}`, 'login')}
                    className="absolute right-1.5 top-1.5 rounded border border-[#3A3A3A] px-1.5 py-0.5 text-[9px] text-zinc-500 opacity-0 transition-opacity hover:bg-white/5 hover:text-zinc-300 group-hover:opacity-100"
                  >
                    {copied === 'login' ? '✓' : 'Copy'}
                  </button>
                </div>
                <p className="text-[9px] text-amber-400/60">Token shown once — copy it now.</p>
              </div>
            )}
          </div>

          {/* Step 3 */}
          <div className="rounded-lg border border-[#2B2B2B] px-4 py-3" style={{ backgroundColor: '#1F1F1F' }}>
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500/10 text-[10px] font-bold text-blue-400">3</span>
              <span className="text-[12px] font-medium text-zinc-300">Start the companion</span>
            </div>
            <div className="group relative">
              <pre className="rounded-md border border-[#2B2B2B] px-3 py-2 font-mono text-[11px] text-blue-300/80" style={{ backgroundColor: '#151515' }}>
                bornastar start
              </pre>
              <button
                onClick={() => copyToClipboard('bornastar start', 'start')}
                className="absolute right-1.5 top-1.5 rounded border border-[#3A3A3A] px-1.5 py-0.5 text-[9px] text-zinc-500 opacity-0 transition-opacity hover:bg-white/5 hover:text-zinc-300 group-hover:opacity-100"
              >
                {copied === 'start' ? '✓' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Step 4 — Status */}
          <div className="rounded-lg border border-[#2B2B2B] px-4 py-3" style={{ backgroundColor: '#1F1F1F' }}>
            <div className="flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-500/10 text-[10px] font-bold text-zinc-500">4</span>
              {companionStatus === 'waiting' ? (
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                  <span className="text-[12px] text-zinc-500">Waiting for companion...</span>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span className="text-[12px] font-medium text-emerald-400">Connected! Loading dashboard...</span>
                </div>
              )}
            </div>
          </div>

        </div>


      </div>
    </div>
  )
}
