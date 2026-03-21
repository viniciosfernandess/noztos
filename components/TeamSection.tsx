'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Collaborator {
  id: string
  name: string
}

interface Team {
  id: string
  name: string
  collaboratorOrder: { collaboratorIds: string[] }
}

interface TeamSectionProps {
  projectId: string
  teams: Team[]
  collaborators: Collaborator[]
}

export function TeamSection({ projectId, teams, collaborators }: TeamSectionProps) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  function toggleCollaborator(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  async function createTeam(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || selectedIds.length === 0) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), collaboratorIds: selectedIds }),
      })
      if (res.ok) {
        setShowForm(false)
        setName('')
        setSelectedIds([])
        router.refresh()
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function deleteTeam(teamId: string) {
    setDeleting(teamId)
    try {
      const res = await fetch(`/api/projects/${projectId}/teams/${teamId}`, {
        method: 'DELETE',
      })
      if (res.ok) router.refresh()
    } finally {
      setDeleting(null)
    }
  }

  function collaboratorName(id: string) {
    return collaborators.find((c) => c.id === id)?.name ?? id
  }

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
          Teams
        </h2>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-50"
          >
            + New Team
          </button>
        )}
      </div>

      {teams.length === 0 && !showForm && (
        <p className="mt-2 text-sm text-zinc-400">
          No teams yet. Create a team to organize your collaborators into a pipeline.
        </p>
      )}

      {teams.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {teams.map((team) => (
            <div
              key={team.id}
              className="flex items-center justify-between rounded-lg border border-zinc-100 px-4 py-3 dark:border-zinc-800"
            >
              <div>
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {team.name}
                </span>
                <p className="text-xs text-zinc-400">
                  {team.collaboratorOrder.collaboratorIds
                    .map(collaboratorName)
                    .join(' → ')}
                </p>
              </div>
              <button
                onClick={() => deleteTeam(team.id)}
                disabled={deleting === team.id}
                className="text-xs text-zinc-400 transition-colors hover:text-red-500 disabled:opacity-50"
              >
                {deleting === team.id ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <form onSubmit={createTeam} className="mt-4 flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
          <input
            type="text"
            placeholder="Team name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-9 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <div>
            <p className="text-xs font-medium text-zinc-500 mb-2">Select collaborators (in pipeline order):</p>
            <div className="flex flex-wrap gap-2">
              {collaborators.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCollaborator(c.id)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    selectedIds.includes(c.id)
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-zinc-900'
                      : 'border-zinc-200 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800'
                  }`}
                >
                  {selectedIds.includes(c.id)
                    ? `${selectedIds.indexOf(c.id) + 1}. ${c.name}`
                    : c.name}
                </button>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting || !name.trim() || selectedIds.length === 0}
              className="flex h-8 items-center justify-center rounded-full bg-zinc-900 px-4 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
            >
              {submitting ? 'Creating...' : 'Create Team'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setName(''); setSelectedIds([]) }}
              className="text-xs text-zinc-400 hover:text-zinc-600"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  )
}
