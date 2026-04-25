'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useGitHubModal } from './GitHubModal'
import { ClaudeSetupModal } from './ClaudeSetupModal'
import { useCompanionStatus, useCompanionInfo } from '@/lib/hooks/useCompanionStore'

// ── Sidebar connection state ────────────────────────────────────────
// Companion + Machine state are now derived from the single reactive
// source of truth: the companionStore, populated live over SSE by
// CompanionProvider. When the server's heartbeat sweeper flips a
// channel to disconnected, this sidebar re-renders within the same
// tick as the chat input — one truth, one UI reaction.
//
// GitHub state stays on its own short poll: unrelated concern, and
// the GitHub OAuth flow doesn't emit status into our SSE stream.
interface GitHubStatus {
  state: 'connected' | 'not_connected' | 'checking'
  detail?: string
}

export function DashboardSidebar() {
  const { openGitHub } = useGitHubModal()
  const [mounted, setMounted] = useState(false)
  const companionStatus = useCompanionStatus()
  const companionInfo = useCompanionInfo()
  const [github, setGithub] = useState<GitHubStatus>({ state: 'checking' })
  const [showMachineMenu, setShowMachineMenu] = useState(false)
  const [showClaudeSetup, setShowClaudeSetup] = useState(false)
  const [showReconnectModal, setShowReconnectModal] = useState<'same' | 'new' | null>(null)
  const [showReinstall, setShowReinstall] = useState(false)
  const [reconnectToken, setReconnectToken] = useState<string | null>(null)
  const [generatingToken, setGeneratingToken] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [hoveredTooltip, setHoveredTooltip] = useState<'claude' | 'github' | 'machine' | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setMounted(true) }, [])

  function enterTooltip(name: 'claude' | 'github' | 'machine') {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    setHoveredTooltip(name)
  }

  function leaveTooltip() {
    leaveTimer.current = setTimeout(() => setHoveredTooltip(null), 200)
  }

  // GitHub auth is orthogonal to the companion daemon — keep its own
  // lightweight poll. Companion / Claude state now flows through SSE.
  useEffect(() => {
    async function checkGitHub() {
      try {
        const res = await fetch('/api/github/status')
        const data = await res.json()
        setGithub({
          state: data.connected ? 'connected' : 'not_connected',
          detail: data.connected ? `@${data.username}` : 'Not connected',
        })
      } catch {
        setGithub({ state: 'not_connected', detail: 'Not connected' })
      }
    }
    checkGitHub()
    const interval = setInterval(checkGitHub, 15000)
    return () => clearInterval(interval)
  }, [])

  // Derived companion / machine presentation. The store's companionStatus
  // is the single source: 'connected' | 'connecting' | 'disconnected' |
  // 'error'. We split the two concerns the sidebar surfaces:
  //   - Claude auth inside the companion (info.plan signals auth)
  //   - Machine reachability (whether SSE heartbeat is fresh)
  const isCompanionLive = companionStatus === 'connected'
  const isClaudeAuthed = isCompanionLive && Boolean(companionInfo?.plan)
  const claudeState: 'connected' | 'offline' | 'checking' = companionStatus === 'connecting'
    ? 'checking'
    : isClaudeAuthed ? 'connected' : 'offline'
  const claudeDetail = !isCompanionLive
    ? 'Companion not running'
    : !isClaudeAuthed
      ? 'Claude not authenticated — run: claude login'
      : `Claude Code ${companionInfo?.version?.split(' ')[0] ?? ''} — ${companionInfo?.plan ?? 'subscription'}`
  const machineState: 'connected' | 'offline' | 'checking' = companionStatus === 'connecting'
    ? 'checking'
    : isCompanionLive ? 'connected' : 'offline'
  const machineName = companionInfo?.email ?? 'Local Machine'

  const generateNewToken = useCallback(async () => {
    setGeneratingToken(true)
    try {
      const listRes = await fetch('/api/companion/tokens')
      const listData = await listRes.json()
      for (const t of listData.tokens ?? []) {
        await fetch('/api/companion/tokens', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: t.id }),
        })
      }
      const res = await fetch('/api/companion/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: showReconnectModal === 'new' ? 'New Machine' : 'Reconnect' }),
      })
      const data = await res.json()
      if (data.token) setReconnectToken(data.token)
    } catch {}
    setGeneratingToken(false)
  }, [showReconnectModal])

  function copyToClipboard(text: string, id: string) {
    navigator.clipboard?.writeText(text)
    setCopied(id)
    setTimeout(() => setCopied(null), 2000)
  }

  function closeModal() {
    setShowReconnectModal(null)
    setReconnectToken(null)
    setShowReinstall(false)
    setShowMachineMenu(false)
  }

  if (!mounted) {
    return (
      <div className="flex w-20 shrink-0 flex-col items-center gap-4 border-r border-white/5 py-6" style={{ backgroundColor: '#15151c' }} />
    )
  }

  return (
    <>
      <div
        className="flex w-20 shrink-0 flex-col items-center gap-4 border-r border-white/5 py-6"
        style={{ backgroundColor: '#15151c' }}
      >
        {/* Claude Code */}
        <div
          className="relative flex flex-col items-center"
          onMouseEnter={() => enterTooltip('claude')}
          onMouseLeave={leaveTooltip}
        >
          <button
            onClick={() => { if (claudeState !== 'connected') setShowClaudeSetup(true) }}
            className="flex h-14 w-14 items-center justify-center rounded-xl transition-colors hover:bg-white/5"
          >
            <img src="/claude-logo.png" alt="Claude" className="h-8 w-8 rounded" />
          </button>
          <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${
            claudeState === 'connected' ? 'bg-emerald-400' :
            claudeState === 'checking' ? 'bg-zinc-600 animate-pulse' :
            'bg-amber-400'
          }`} />
          <div
            className={`absolute left-full top-0 z-50 ml-2 w-48 rounded-md border border-[#2B2B2B] px-3 py-2 shadow-xl transition-opacity ${hoveredTooltip === 'claude' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
            style={{ backgroundColor: '#252526' }}
            onMouseEnter={() => enterTooltip('claude')}
            onMouseLeave={leaveTooltip}
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${claudeState === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="text-[11px] font-medium text-zinc-200">Claude Code</span>
            </div>
            <p className="mt-1 text-[10px] text-zinc-500">{claudeDetail}</p>
            {claudeState !== 'connected' && (
              <button
                onClick={() => setShowClaudeSetup(true)}
                className="mt-2 w-full rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium text-zinc-200 transition-colors hover:bg-white/15"
              >
                Setup Claude Code
              </button>
            )}
          </div>
        </div>

        {/* GitHub */}
        <div
          className="relative flex flex-col items-center"
          onMouseEnter={() => enterTooltip('github')}
          onMouseLeave={leaveTooltip}
        >
          <button
            onClick={() => { if (github.state !== 'connected') openGitHub() }}
            className="flex h-14 w-14 items-center justify-center rounded-xl transition-colors hover:bg-white/5"
          >
            <svg className="h-8 w-8 text-zinc-400" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
          </button>
          <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${
            github.state === 'connected' ? 'bg-emerald-400' :
            github.state === 'checking' ? 'bg-zinc-600 animate-pulse' :
            'bg-zinc-600'
          }`} />
          <div
            className={`absolute left-full top-0 z-50 ml-2 w-48 rounded-md border border-[#2B2B2B] px-3 py-2 shadow-xl transition-opacity ${hoveredTooltip === 'github' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
            style={{ backgroundColor: '#252526' }}
            onMouseEnter={() => enterTooltip('github')}
            onMouseLeave={leaveTooltip}
          >
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${github.state === 'connected' ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
              <span className="text-[11px] font-medium text-zinc-200">GitHub</span>
            </div>
            <p className="mt-1 text-[10px] text-zinc-500">{github.detail ?? 'Checking...'}</p>
            {github.state !== 'connected' && (
              <button
                onClick={() => openGitHub()}
                className="mt-2 w-full rounded-md bg-white/10 px-2 py-1 text-[10px] font-medium text-zinc-200 transition-colors hover:bg-white/15"
              >
                Connect GitHub
              </button>
            )}
          </div>
        </div>

        <div className="mx-3 border-t border-white/5" />

        {/* Machine + Cloud */}
        <div
          className="relative flex flex-col items-center"
          onMouseEnter={() => enterTooltip('machine')}
          onMouseLeave={leaveTooltip}
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-xl transition-colors hover:bg-white/5">
            <svg className="h-8 w-8 text-zinc-400" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25A2.25 2.25 0 015.25 3h13.5A2.25 2.25 0 0121 5.25z" />
            </svg>
          </div>
          <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${
            machineState === 'connected' ? 'bg-emerald-400' :
            machineState === 'checking' ? 'bg-zinc-600 animate-pulse' :
            'bg-amber-400'
          }`} />
          <div
            className={`absolute left-full top-0 z-50 ml-2 w-56 rounded-lg border border-[#2B2B2B] p-3 shadow-xl transition-opacity ${hoveredTooltip === 'machine' ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
            style={{ backgroundColor: '#252526' }}
            onMouseEnter={() => enterTooltip('machine')}
            onMouseLeave={leaveTooltip}
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${machineState === 'connected' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium text-zinc-200">
                  {machineName}
                </p>
                <p className="text-[9px] text-zinc-500">
                  {machineState === 'connected'
                    ? 'Connected — running locally'
                    : machineState === 'checking'
                      ? 'Connecting…'
                      : 'Offline — start companion to reconnect'}
                </p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setShowMachineMenu(!showMachineMenu) }}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-white/10 hover:text-zinc-300"
              >
                <svg className="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="3" cy="8" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="13" cy="8" r="1.5" />
                </svg>
              </button>
            </div>

            {showMachineMenu && (
              <div className="mt-2 overflow-hidden rounded-md border border-[#3A3A3A]" style={{ backgroundColor: '#2A2A2A' }}>
                <button
                  onClick={() => { setShowReconnectModal('same'); setShowMachineMenu(false) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-zinc-300 hover:bg-white/5"
                >
                  <svg className="h-3.5 w-3.5 text-amber-400" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                  Restore local connection
                </button>
                <div className="border-t border-white/5" />
                <button
                  onClick={() => { setShowReconnectModal('new'); setShowMachineMenu(false) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11px] text-zinc-300 hover:bg-white/5"
                >
                  <svg className="h-3.5 w-3.5 text-blue-400" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                  </svg>
                  Change local machine
                </button>
              </div>
            )}

            <div className="my-2 border-t border-white/5" />

            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
              <div>
                <p className="text-[11px] font-medium text-zinc-200">Cloud</p>
                <p className="text-[9px] text-zinc-500">
                  {machineState === 'connected'
                    ? 'Available — ready if needed'
                    : 'Available — switch to cloud to continue working'}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showClaudeSetup && (
        <ClaudeSetupModal onClose={() => setShowClaudeSetup(false)} />
      )}

      {showReconnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
          <div className="w-full max-w-md rounded-xl border border-[#2B2B2B] p-6 shadow-2xl" style={{ backgroundColor: '#1F1F1F' }}>
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-zinc-100">
                {showReconnectModal === 'same' ? 'Restore local connection' : 'Change local machine'}
              </h2>
              <button onClick={closeModal} className="text-zinc-500 hover:text-zinc-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="mb-4 text-[12px] text-zinc-400">
              {showReconnectModal === 'same'
                ? 'Generate a new token and run these steps on the same machine to restore the connection.'
                : 'Generate a new token for your new machine. The previous connection will be revoked.'}
            </p>

            {showReconnectModal === 'same' && !showReinstall && (
              <button
                onClick={() => setShowReinstall(true)}
                className="mb-3 text-[10px] text-zinc-600 transition-colors hover:text-zinc-400"
              >
                Need to reinstall the CLI?
              </button>
            )}
            {(showReconnectModal === 'new' || showReinstall) && (
              <div className="mb-3 rounded-lg border border-[#2B2B2B] px-4 py-3" style={{ backgroundColor: '#181818' }}>
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-500/10 text-[10px] font-bold text-blue-400">1</span>
                  <span className="text-[12px] font-medium text-zinc-300">Install the CLI</span>
                </div>
                <div className="group relative">
                  <pre className="rounded-md border border-[#2B2B2B] px-3 py-2 font-mono text-[11px] text-blue-300/80" style={{ backgroundColor: '#151515' }}>
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
            )}

            <div className="mb-3 rounded-lg border border-[#2B2B2B] px-4 py-3" style={{ backgroundColor: '#181818' }}>
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/10 text-[10px] font-bold text-violet-400">
                  {showReconnectModal === 'new' ? '2' : '1'}
                </span>
                <span className="text-[12px] font-medium text-zinc-300">Authenticate</span>
              </div>
              {!reconnectToken ? (
                <button
                  onClick={generateNewToken}
                  disabled={generatingToken}
                  className="w-full rounded-md bg-violet-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
                >
                  {generatingToken ? 'Generating...' : 'Generate New Token'}
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="group relative">
                    <pre className="whitespace-pre-wrap break-all rounded-md border border-[#2B2B2B] px-3 py-2 font-mono text-[11px] text-violet-300/80" style={{ backgroundColor: '#151515' }}>
                      bornastar login {reconnectToken}
                    </pre>
                    <button
                      onClick={() => copyToClipboard(`bornastar login ${reconnectToken}`, 'login')}
                      className="absolute right-1.5 top-1.5 rounded border border-[#3A3A3A] px-1.5 py-0.5 text-[9px] text-zinc-500 opacity-0 transition-opacity hover:bg-white/5 hover:text-zinc-300 group-hover:opacity-100"
                    >
                      {copied === 'login' ? '✓' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-[9px] text-amber-400/60">Token shown once — copy it now. Previous tokens revoked.</p>
                </div>
              )}
            </div>

            <div className="rounded-lg border border-[#2B2B2B] px-4 py-3" style={{ backgroundColor: '#181818' }}>
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500/10 text-[10px] font-bold text-emerald-400">
                  {showReconnectModal === 'new' ? '3' : '2'}
                </span>
                <span className="text-[12px] font-medium text-zinc-300">Start companion</span>
              </div>
              <div className="group relative">
                <pre className="rounded-md border border-[#2B2B2B] px-3 py-2 font-mono text-[11px] text-emerald-300/80" style={{ backgroundColor: '#151515' }}>
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

            <div className="mt-4 flex justify-end">
              <button
                onClick={closeModal}
                className="rounded-md border border-[#3A3A3A] px-4 py-1.5 text-[11px] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
