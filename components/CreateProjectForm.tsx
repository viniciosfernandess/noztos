'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useGitHubModal } from './GitHubModal'
import { useCompanionStatus } from '@/lib/hooks/useCompanionStore'
import { invalidateProjects } from '@/lib/projects-cache'

// Mint a project id client-side BEFORE the network round-trip. Lets
// `POST /api/projects` be idempotent on retry: a re-clicked Create
// after a network blip resends the same id, the server upserts and
// returns the existing row instead of creating a duplicate.
//
// Format matches the regex POST /api/projects validates against
// (`^c[a-z0-9]{19,31}$`): a `c` prefix + 24 chars from base36 of 16
// crypto-random bytes. Same shape as Prisma's default cuid; we don't
// pull in the cuid lib for this single call site.
function mintCuid(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let s = 'c'
  for (const b of bytes) s += b.toString(36).padStart(2, '0')
  return s.slice(0, 25)
}

export function CreateProjectButton({ label }: { label?: string } = {}) {
  const [showPicker, setShowPicker] = useState(false)
  // Adding a project requires the local companion to be reachable so
  // the daemon can register the folder path (clone target / local scan
  // result / new template scaffold). Claude auth is irrelevant here —
  // the user can sign Claude in later. When cloud sandbox lands, this
  // gate flips to "either local OR cloud is ready".
  const companionStatus = useCompanionStatus()
  const companionConnected = companionStatus === 'connected'

  return (
    <>
      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => setShowPicker(true)}
          disabled={!companionConnected}
          title={companionConnected ? '' : 'Local offline. Reconnect to add projects.'}
          className="flex h-10 items-center justify-center rounded-full bg-zinc-900 px-5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {label ?? 'New Project'}
        </button>
        {!companionConnected && (
          // Visible hint instead of relying on the disabled-button
          // tooltip alone — same dim/zinc styling we use in the chat
          // input banner so the offline language is consistent across
          // the app. Disappears the moment the daemon heartbeats back.
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
            <span>
              {companionStatus === 'connecting'
                ? 'Connecting to local…'
                : 'Local offline. Reconnect to add projects.'}
            </span>
          </div>
        )}
      </div>
      {showPicker && <ProjectPickerModal onClose={() => setShowPicker(false)} />}
    </>
  )
}

// ── Project Picker Modal ─────────────────────────────────────────────

function ProjectPickerModal({ onClose }: { onClose: () => void }) {
  const router = useRouter()
  const { openGitHub } = useGitHubModal()
  const [mode, setMode] = useState<'pick' | 'local' | 'create'>('pick')
  const [localPath, setLocalPath] = useState('')
  const [projectName, setProjectName] = useState('')
  const [template, setTemplate] = useState('nextjs')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scannedRepos, setScannedRepos] = useState<Array<{ name: string; path: string; parentDir: string }>>([])
  const [scanning, setScanning] = useState(false)

  // Scan local repos when entering local mode
  useEffect(() => {
    if (mode !== 'local') return
    setScanning(true)

    // Send scan command
    fetch('/api/companion/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'scan_repos' }),
    })

    // Listen for results via stream
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
              if (inner?.subtype === 'scan_repos_result') {
                const repos = JSON.parse(inner.content as string)
                setScannedRepos(repos)
                setScanning(false)
                controller.abort()
                return
              }
            } catch {}
          }
        }
      } catch {}
    }
    listen()

    // Timeout after 5s
    const timeout = setTimeout(() => { setScanning(false); controller.abort() }, 5000)
    return () => { controller.abort(); clearTimeout(timeout) }
  }, [mode])

  // From GitHub — clone + register. DB project created FIRST with a
  // client-minted cuid, so a network retry hits the same id and the
  // server upserts (no duplicate row). Daemon receives the cuid as
  // its own project id, keeping fs-watcher path and worktrees dir
  // aligned with the DB from the start.
  function handleGitHub() {
    onClose()
    openGitHub({
      onRepoSelected: async (repo) => {
        const tStart = Date.now()
        try {
          const projectId = mintCuid()
          console.log(`[create-form] github mint cuid=${projectId.slice(0, 8)} repo=${repo.owner}/${repo.name}`)
          const res = await fetch('/api/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: projectId, name: repo.name }),
          })
          if (!res.ok) {
            console.warn(`[create-form] github POST /api/projects failed status=${res.status}`)
            return
          }
          const { id } = await res.json()
          console.log(`[create-form] github DB row created id=${id.slice(0, 8)} ms=${Date.now() - tStart}`)
          await fetch(`/api/projects/${id}/repository`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              owner: repo.owner,
              repo: repo.name,
              branch: repo.defaultBranch,
            }),
          })
          console.log(`[create-form] github DONE id=${id.slice(0, 8)} totalMs=${Date.now() - tStart}`)
          // New project isn't in the cached switcher list yet — drop so
          // the next ProjectLayout mount refetches.
          invalidateProjects()
          router.push(`/projects/${id}`)
          router.refresh()
        } catch (err) {
          console.warn(`[create-form] github threw: ${(err as Error).message}`)
        }
      },
    })
  }

  // From local folder — DB row first (with our minted cuid), then we
  // pass that cuid to the daemon's init_project so both sides share
  // the same id. Repository row links DB project to disk path.
  async function handleLocal() {
    if (!localPath.trim()) return
    setLoading(true)
    setError(null)
    const tStart = Date.now()
    try {
      const path = localPath.trim()
      const folderName = path.split('/').pop() ?? 'project'
      const projectId = mintCuid()
      console.log(`[create-form] local mint cuid=${projectId.slice(0, 8)} path=${path}`)

      // 1. Create DB project with our minted cuid (idempotent on retry).
      const tDb = Date.now()
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: projectId, name: folderName }),
      })
      if (!res.ok) {
        console.warn(`[create-form] local POST /api/projects failed status=${res.status} ms=${Date.now() - tDb}`)
        setError('Failed to create project')
        setLoading(false)
        return
      }
      const { id } = await res.json()
      console.log(`[create-form] local step1 DB row id=${id.slice(0, 8)} ms=${Date.now() - tDb}`)

      // 2. Register with the companion daemon, passing the SAME cuid so
      // the daemon's local config row uses it as the project id —
      // fs-watcher path, worktrees dir, and provisionWorktree all
      // converge. Idempotent — re-running on the same path just
      // refreshes the entry.
      const tDaemon = Date.now()
      await fetch('/api/companion/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'init_project', targetPath: path, projectId: id }),
      }).catch(() => {})
      console.log(`[create-form] local step2 daemon init_project ms=${Date.now() - tDaemon}`)

      // 3. Repository record links DB project to local path.
      const tRepo = Date.now()
      await fetch(`/api/projects/${id}/repository`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: path }),
      })
      console.log(`[create-form] local step3 /repository ms=${Date.now() - tRepo}`)
      console.log(`[create-form] local DONE id=${id.slice(0, 8)} totalMs=${Date.now() - tStart}`)

      // New project doesn't appear in the cached switcher list yet —
      // drop the cache so the next ProjectLayout mount refetches.
      invalidateProjects()
      router.push(`/projects/${id}`)
      router.refresh()
    } catch (err) {
      console.warn(`[create-form] local threw: ${(err as Error).message}`)
      setError('Something went wrong')
    }
    setLoading(false)
  }

  // Create new — DB row first (with our minted cuid), then daemon
  // scaffolds the directory + git init. Same cuid flows through both
  // sides — same alignment guarantee as handleLocal.
  async function handleCreate() {
    if (!projectName.trim()) return
    setLoading(true)
    setError(null)
    const tStart = Date.now()
    try {
      // ~/projects/ is resolved by the companion on the user's machine
      const targetPath = `~/projects/${projectName.trim()}`
      const projectId = mintCuid()
      console.log(`[create-form] scratch mint cuid=${projectId.slice(0, 8)} name=${projectName.trim()} template=${template}`)

      // 1. Create DB project (idempotent on retry).
      const tDb = Date.now()
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: projectId, name: projectName.trim() }),
      })
      if (!res.ok) {
        console.warn(`[create-form] scratch POST /api/projects failed status=${res.status}`)
        setError('Failed to create project')
        setLoading(false)
        return
      }
      const { id } = await res.json()
      console.log(`[create-form] scratch step1 DB row id=${id.slice(0, 8)} ms=${Date.now() - tDb}`)

      // 2. Tell the daemon to scaffold + register, passing the cuid so
      // the daemon's project id matches the DB.
      const tDaemon = Date.now()
      const cmdRes = await fetch('/api/companion/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'create_project',
          projectId: id,
          targetPath,
          template,
          projectName: projectName.trim(),
        }),
      })
      if (!cmdRes.ok) {
        const data = await cmdRes.json()
        console.warn(`[create-form] scratch step2 daemon create_project failed status=${cmdRes.status}`)
        setError(data.error ?? data.message ?? 'Failed')
        setLoading(false)
        return
      }
      console.log(`[create-form] scratch step2 daemon create_project queued ms=${Date.now() - tDaemon}`)

      // 3. Register the local path so the file tree and git ops work.
      // Server resolves ~ via homedir() on the daemon's machine.
      const tRepo = Date.now()
      await fetch(`/api/projects/${id}/repository`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: targetPath }),
      })
      console.log(`[create-form] scratch step3 /repository ms=${Date.now() - tRepo}`)
      console.log(`[create-form] scratch DONE id=${id.slice(0, 8)} totalMs=${Date.now() - tStart}`)
      // New project doesn't appear in the cached switcher list yet —
      // drop the cache so the next ProjectLayout mount refetches.
      invalidateProjects()
      router.push(`/projects/${id}`)
      router.refresh()
    } catch (err) {
      console.warn(`[create-form] scratch threw: ${(err as Error).message}`)
      setError('Something went wrong')
    }
    setLoading(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}>
      <div className="w-full max-w-md rounded-xl border border-[#2B2B2B] shadow-2xl" style={{ backgroundColor: '#1F1F1F' }}>

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2B2B2B] px-5 py-4">
          <h2 className="text-[15px] font-semibold text-zinc-100">
            {mode === 'pick' ? 'New Project' : mode === 'local' ? 'Open local project' : 'Create new project'}
          </h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5">
          {/* Mode picker */}
          {mode === 'pick' && (
            <div className="space-y-2">
              {/* From GitHub */}
              <button
                onClick={handleGitHub}
                className="flex w-full items-center gap-4 rounded-lg border border-[#2B2B2B] px-4 py-3.5 text-left transition-colors hover:bg-white/5"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5">
                  <svg className="h-5 w-5 text-zinc-300" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[13px] font-medium text-zinc-200">Clone from GitHub</p>
                  <p className="text-[11px] text-zinc-500">Select a repository from your GitHub account</p>
                </div>
              </button>

              {/* From local */}
              <button
                onClick={() => setMode('local')}
                className="flex w-full items-center gap-4 rounded-lg border border-[#2B2B2B] px-4 py-3.5 text-left transition-colors hover:bg-white/5"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5">
                  <svg className="h-5 w-5 text-zinc-300" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[13px] font-medium text-zinc-200">Open local project</p>
                  <p className="text-[11px] text-zinc-500">Open an existing project from your machine</p>
                </div>
              </button>

              {/* Create new */}
              <button
                onClick={() => setMode('create')}
                className="flex w-full items-center gap-4 rounded-lg border border-[#2B2B2B] px-4 py-3.5 text-left transition-colors hover:bg-white/5"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/5">
                  <svg className="h-5 w-5 text-zinc-300" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                </div>
                <div>
                  <p className="text-[13px] font-medium text-zinc-200">Create from scratch</p>
                  <p className="text-[11px] text-zinc-500">Start a new project with a template</p>
                </div>
              </button>
            </div>
          )}

          {/* Local project form */}
          {mode === 'local' && (
            <div className="space-y-3">
              {/* Scanned repos list */}
              {scanning && (
                <div className="flex items-center gap-2 py-3">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                  <span className="text-[11px] text-zinc-500">Scanning your machine...</span>
                </div>
              )}
              {!scanning && scannedRepos.length > 0 && (
                <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-[#2B2B2B]" style={{ backgroundColor: '#151515' }}>
                  {/* Group by parentDir */}
                  {(() => {
                    const groups = new Map<string, typeof scannedRepos>()
                    for (const r of scannedRepos) {
                      const list = groups.get(r.parentDir) ?? []
                      list.push(r)
                      groups.set(r.parentDir, list)
                    }
                    return Array.from(groups.entries()).map(([dir, repos]) => (
                      <div key={dir}>
                        <div className="sticky top-0 px-3 py-1.5 text-[9px] font-medium uppercase tracking-wider text-zinc-600" style={{ backgroundColor: '#151515' }}>
                          {dir}
                        </div>
                        {repos.map((repo) => (
                          <button
                            key={repo.path}
                            onClick={() => setLocalPath(repo.path)}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5 ${
                              localPath === repo.path ? 'bg-white/5' : ''
                            }`}
                          >
                            <svg className="h-3.5 w-3.5 shrink-0 text-zinc-500" viewBox="0 0 24 24" fill="none" strokeWidth={1.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                            </svg>
                            <span className="text-[12px] text-zinc-300">{repo.name}</span>
                          </button>
                        ))}
                      </div>
                    ))
                  })()}
                </div>
              )}
              {!scanning && scannedRepos.length === 0 && (
                <p className="py-2 text-[11px] text-zinc-600">No git repositories found in common directories</p>
              )}

              {/* Manual path input */}
              <div>
                <label className="mb-1.5 block text-[10px] text-zinc-500">Or paste a path</label>
                <input
                  type="text"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="~/projects/my-app"
                  className="w-full rounded-lg border border-[#2B2B2B] bg-[#151515] px-3 py-2 font-mono text-[12px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
                />
              </div>
              {error && <p className="text-[11px] text-red-400">{error}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => { setMode('pick'); setError(null) }}
                  className="rounded-md border border-[#3A3A3A] px-3 py-1.5 text-[11px] text-zinc-400 hover:bg-white/5"
                >
                  Back
                </button>
                <button
                  onClick={handleLocal}
                  disabled={!localPath.trim() || loading}
                  className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {loading ? 'Opening...' : 'Open project'}
                </button>
              </div>
            </div>
          )}

          {/* Create project form */}
          {mode === 'create' && (
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">Project name</label>
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="my-new-app"
                  autoFocus
                  className="w-full rounded-lg border border-[#2B2B2B] bg-[#151515] px-3 py-2 text-[12px] text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-zinc-400">Template</label>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'nextjs', name: 'Next.js', desc: 'React + TypeScript' },
                    { id: 'vite', name: 'Vite', desc: 'React + TypeScript' },
                    { id: 'node', name: 'Node.js', desc: 'Bare Node project' },
                    { id: 'python', name: 'Python', desc: 'Python + venv' },
                  ].map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTemplate(t.id)}
                      className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                        template === t.id
                          ? 'border-emerald-500/50 bg-emerald-500/5'
                          : 'border-[#2B2B2B] hover:bg-white/5'
                      }`}
                    >
                      <p className={`text-[11px] font-medium ${template === t.id ? 'text-emerald-400' : 'text-zinc-300'}`}>{t.name}</p>
                      <p className="text-[9px] text-zinc-600">{t.desc}</p>
                    </button>
                  ))}
                </div>
              </div>
              {error && <p className="text-[11px] text-red-400">{error}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => { setMode('pick'); setError(null) }}
                  className="rounded-md border border-[#3A3A3A] px-3 py-1.5 text-[11px] text-zinc-400 hover:bg-white/5"
                >
                  Back
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!projectName.trim() || loading}
                  className="flex-1 rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {loading ? 'Creating...' : 'Create project'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
