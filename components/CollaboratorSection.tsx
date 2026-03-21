'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { SkillEditor } from './SkillEditor'

interface Collaborator {
  id: string
  name: string
  description: string
  phase: string
  skillMd: string
}

interface Template {
  id: string
  name: string
  description: string
  phase: string
}

interface CollaboratorSectionProps {
  projectId: string
  collaborators: Collaborator[]
  templates: Template[]
}

export function CollaboratorSection({ projectId, collaborators, templates }: CollaboratorSectionProps) {
  const router = useRouter()
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [editingSkill, setEditingSkill] = useState<Collaborator | null>(null)

  async function addFromTemplate(templateId: string) {
    setAdding(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId }),
      })
      if (res.ok) {
        router.refresh()
      }
    } finally {
      setAdding(false)
    }
  }

  async function removeCollaborator(collaboratorId: string) {
    setDeleting(collaboratorId)
    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators/${collaboratorId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        router.refresh()
      }
    } finally {
      setDeleting(null)
    }
  }

  // Templates not yet added to this project
  const available = templates.filter(
    (t) => !collaborators.some((c) => c.name === t.name)
  )

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
        Collaborators
      </h2>

      {collaborators.length === 0 ? (
        <p className="mt-2 text-sm text-zinc-400">
          No collaborators yet. Add from templates below.
        </p>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {collaborators.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between rounded-lg border border-zinc-100 px-4 py-3 dark:border-zinc-800"
            >
              <div>
                <span className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {c.name}
                </span>
                <span className="ml-2 text-xs text-zinc-400">{c.phase}</span>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {c.description}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setEditingSkill(c)}
                  className="text-xs text-zinc-500 transition-colors hover:text-zinc-900 dark:hover:text-zinc-50"
                >
                  Edit Skill
                </button>
                <button
                  onClick={() => removeCollaborator(c.id)}
                  disabled={deleting === c.id}
                  className="text-xs text-zinc-400 transition-colors hover:text-red-500 disabled:opacity-50"
                >
                  {deleting === c.id ? 'Removing...' : 'Remove'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-400">
            Add from templates
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {available.map((t) => (
              <button
                key={t.id}
                onClick={() => addFromTemplate(t.id)}
                disabled={adding}
                className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                + {t.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {editingSkill && (
        <SkillEditor
          projectId={projectId}
          collaboratorId={editingSkill.id}
          collaboratorName={editingSkill.name}
          initialSkillMd={editingSkill.skillMd}
          onClose={() => setEditingSkill(null)}
          onSaved={() => {
            setEditingSkill(null)
            router.refresh()
          }}
        />
      )}
    </section>
  )
}
