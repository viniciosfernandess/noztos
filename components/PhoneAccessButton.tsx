'use client'

// Navbar button + popover that controls the cloudflared quick tunnel.
//
// Behaviour:
//   • Polls /api/tunnel on mount + every 5 s.
//   • Click button → toggle popover open. Popover renders one of:
//     - "Enable phone access" — when stopped, big violet button.
//     - "Connecting…" — while cloudflared is spawning + before the URL
//       line appears in its stdout.
//     - QR code + URL + Disable — when running.
//     - "cloudflared not installed" — with brew install hint.
//     - "Tunnel error" — surface the cloudflared exit reason.
//   • Click outside the popover → closes.

import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'

type TunnelStatus =
  | { state: 'stopped' }
  | { state: 'starting' }
  | { state: 'running'; url: string; startedAt: number; basicAuth?: { username: string; password: string } }
  | { state: 'missing-binary'; installHint: string }
  | { state: 'missing-authtoken'; setupHint: string }
  | { state: 'error'; message: string }

interface TunnelResponse {
  status: TunnelStatus
}

export function PhoneAccessButton() {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<TunnelResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [authCopied, setAuthCopied] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  async function refresh() {
    try {
      const res = await fetch('/api/tunnel', { cache: 'no-store' })
      if (!res.ok) return
      const j = (await res.json()) as TunnelResponse
      setData(j)
    } catch {
      // Network blip — keep last known state.
    }
  }

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(id)
  }, [])

  // Regenerate QR whenever the live URL changes.
  useEffect(() => {
    const url =
      data?.status.state === 'running' ? data.status.url : null
    if (!url) {
      setQrDataUrl(null)
      return
    }
    QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: '#e4e4e7', light: '#1f1f1f' } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null))
  }, [data])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  async function toggle(action: 'start' | 'stop') {
    setBusy(true)
    try {
      await fetch('/api/tunnel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  function copy(url: string) {
    navigator.clipboard?.writeText(url).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function copyAuth(creds: string) {
    navigator.clipboard?.writeText(creds).catch(() => {})
    setAuthCopied(true)
    setTimeout(() => setAuthCopied(false), 1500)
  }

  const state = data?.status.state ?? 'stopped'
  const dotClass =
    state === 'running'
      ? 'bg-emerald-400'
      : state === 'starting'
        ? 'bg-amber-400 animate-pulse'
        : state === 'error' || state === 'missing-binary'
          ? 'bg-rose-400'
          : 'bg-zinc-600'

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        data-tour="phone-access"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[12px] text-zinc-300 transition-colors hover:bg-white/[0.08]"
        title="Phone access"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <span>{state === 'running' ? 'Phone link on' : 'Phone access'}</span>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-white/10 p-4 shadow-2xl shadow-black/40"
          style={{ backgroundColor: '#1f1f1f' }}
        >
          {!data && (
            <p className="text-[11px] text-zinc-500">Loading…</p>
          )}

          {data?.status.state === 'missing-binary' && (
            <div className="space-y-3">
              <h3 className="text-[12px] font-semibold text-rose-300">ngrok not installed</h3>
              <p className="text-[11px] text-zinc-400">Install it, then try again:</p>
              <pre className="rounded border border-[#2B2B2B] bg-[#151515] px-2 py-1.5 font-mono text-[11px] text-emerald-300/80">
                {data.status.installHint}
              </pre>
            </div>
          )}

          {data?.status.state === 'missing-authtoken' && (
            <div className="space-y-3">
              <h3 className="text-[12px] font-semibold text-amber-300">ngrok authtoken needed</h3>
              <p className="text-[11px] leading-relaxed text-zinc-400">{data.status.setupHint}</p>
              <ol className="ml-4 list-decimal space-y-1 text-[11px] text-zinc-500">
                <li>
                  Go to{' '}
                  <a href="https://dashboard.ngrok.com/signup" target="_blank" rel="noopener" className="text-violet-300 underline">
                    dashboard.ngrok.com/signup
                  </a>{' '}
                  (free)
                </li>
                <li>Copy your authtoken</li>
                <li>
                  Run in your terminal:
                  <pre className="mt-1 rounded border border-[#2B2B2B] bg-[#151515] px-2 py-1.5 font-mono text-[10px] text-emerald-300/80">
                    ngrok config add-authtoken &lt;TOKEN&gt;
                  </pre>
                </li>
                <li>Click Enable again</li>
              </ol>
            </div>
          )}

          {data?.status.state === 'error' && (
            <div className="space-y-3">
              <h3 className="text-[12px] font-semibold text-rose-300">Tunnel error</h3>
              <p className="text-[11px] leading-relaxed text-zinc-400">{data.status.message}</p>
              <button
                disabled={busy}
                onClick={() => toggle('start')}
                className="w-full rounded-md bg-violet-600 px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
              >
                Try again
              </button>
            </div>
          )}

          {(data?.status.state === 'stopped' || !data?.status) && data && (
            <div className="space-y-3">
              <h3 className="text-[12px] font-semibold text-zinc-200">Phone access</h3>
              <p className="text-[11px] leading-relaxed text-zinc-400">
                Generate a temporary public URL via Cloudflare so your phone can use noztos. Login still required.
              </p>
              <button
                disabled={busy}
                onClick={() => toggle('start')}
                className="w-full rounded-md bg-violet-600 px-3 py-2 text-[12px] font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
              >
                {busy ? 'Starting…' : 'Enable phone access'}
              </button>
              <p className="text-[10px] leading-relaxed text-zinc-500">
                URL changes each time you re-enable. The QR code makes re-scanning a 1-second tap.
              </p>
            </div>
          )}

          {data?.status.state === 'starting' && (
            <div className="space-y-3">
              <h3 className="text-[12px] font-semibold text-amber-300">Connecting…</h3>
              <p className="text-[11px] text-zinc-400">
                Spawning cloudflared and waiting for a public URL.
              </p>
              <button
                disabled={busy}
                onClick={() => toggle('stop')}
                className="w-full rounded-md border border-rose-500/30 bg-transparent px-3 py-2 text-[12px] font-medium text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}

          {data?.status.state === 'running' && (() => {
            const liveUrl = data.status.url
            const auth = data.status.basicAuth
            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-[12px] font-semibold text-emerald-300">● Online</h3>
                  <button
                    disabled={busy}
                    onClick={() => toggle('stop')}
                    className="rounded border border-rose-500/30 bg-transparent px-2 py-0.5 text-[10px] font-medium text-rose-300 transition-colors hover:bg-rose-500/10 disabled:opacity-50"
                  >
                    Disable
                  </button>
                </div>

                {qrDataUrl && (
                  <div className="flex justify-center rounded-md border border-[#2B2B2B] bg-[#151515] p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={qrDataUrl} alt="Scan to open on your phone" className="h-44 w-44" />
                  </div>
                )}

                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">URL</p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 truncate rounded border border-[#2B2B2B] bg-[#151515] px-2 py-1 font-mono text-[11px] text-violet-200">
                      {liveUrl}
                    </code>
                    <button
                      onClick={() => copy(liveUrl)}
                      className="rounded border border-[#3A3A3A] bg-[#2A2A2A] px-2 py-1 text-[10px] text-zinc-300 transition-colors hover:bg-[#333]"
                    >
                      {copied ? '✓' : 'Copy'}
                    </button>
                  </div>
                </div>

                {auth && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-500">
                      Tunnel login (asked before the sign-in page)
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 truncate rounded border border-[#2B2B2B] bg-[#151515] px-2 py-1 font-mono text-[11px] text-emerald-200">
                        {auth.username} / {auth.password}
                      </code>
                      <button
                        onClick={() => copyAuth(`${auth.username}:${auth.password}`)}
                        className="rounded border border-[#3A3A3A] bg-[#2A2A2A] px-2 py-1 text-[10px] text-zinc-300 transition-colors hover:bg-[#333]"
                      >
                        {authCopied ? '✓' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-[10px] leading-relaxed text-zinc-500">
                  {auth
                    ? 'ngrok challenges for this login at the edge before the URL even reaches noztos. Your account password is a second gate.'
                    : 'Anyone with this URL sees your sign-in page. Your account password protects access.'}
                </p>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
