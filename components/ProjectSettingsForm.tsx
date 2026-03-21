'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface ProjectSettingsFormProps {
  projectId: string
  initialName: string
  initialSlackChannel: string
}

export function ProjectSettingsForm({
  projectId,
  initialName,
  initialSlackChannel,
}: ProjectSettingsFormProps) {
  const router = useRouter()
  const [name, setName] = useState(initialName)
  const [slackChannel, setSlackChannel] = useState(initialSlackChannel)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSaving(true)
    setSaved(false)

    try {
      const res = await fetch(`/api/projects/${projectId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, slackChannel }),
      })

      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to save')
        return
      }

      setSaved(true)
      router.refresh()
    } catch {
      setError('Network error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="name" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Project name
        </label>
        <input
          id="name"
          type="text"
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="slackChannel" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Slack channel
        </label>
        <input
          id="slackChannel"
          type="text"
          value={slackChannel}
          onChange={(e) => setSlackChannel(e.target.value)}
          placeholder="#my-project"
          className="h-10 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}
      {saved && <p className="text-sm text-emerald-500">Settings saved.</p>}

      <button
        type="submit"
        disabled={saving || !name.trim()}
        className="mt-2 flex h-10 items-center justify-center rounded-full bg-zinc-900 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
      >
        {saving ? 'Saving...' : 'Save Settings'}
      </button>
    </form>
  )
}
