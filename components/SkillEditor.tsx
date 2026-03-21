'use client'

import { useState } from 'react'

interface SkillEditorProps {
  projectId: string
  collaboratorId: string
  collaboratorName: string
  initialSkillMd: string
  onClose: () => void
  onSaved: () => void
}

export function SkillEditor({
  projectId,
  collaboratorId,
  collaboratorName,
  initialSkillMd,
  onClose,
  onSaved,
}: SkillEditorProps) {
  const [skillMd, setSkillMd] = useState(initialSkillMd)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      const res = await fetch(
        `/api/projects/${projectId}/collaborators/${collaboratorId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skillMd }),
        }
      )
      if (res.ok) {
        onSaved()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex w-full max-w-2xl flex-col gap-4 rounded-2xl bg-white p-6 shadow-xl dark:bg-zinc-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Edit Skill — {collaboratorName}
          </h2>
          <button
            onClick={onClose}
            className="text-sm text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            Close
          </button>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Define the instructions and behavior for this AI collaborator. This is
          the system prompt used during task execution.
        </p>

        <textarea
          value={skillMd}
          onChange={(e) => setSkillMd(e.target.value)}
          rows={16}
          placeholder="# Role&#10;&#10;You are a...&#10;&#10;# Instructions&#10;&#10;When given a task, you should..."
          className="w-full rounded-lg border border-zinc-300 bg-white p-3 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
        />

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="h-9 rounded-full px-4 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex h-9 items-center justify-center rounded-full bg-zinc-900 px-4 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-zinc-900"
          >
            {saving ? 'Saving...' : 'Save Skill'}
          </button>
        </div>
      </div>
    </div>
  )
}
