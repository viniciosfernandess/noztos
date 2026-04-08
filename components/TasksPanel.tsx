'use client'

import { useState, useEffect, useRef } from 'react'
import type { ChatReport } from '@/lib/report-types'
import { TaskRunnerViewer } from './TaskRunnerViewer'

// ── Types ──────────────────────────────────────────────────────────────────

type DoneFilter = 'all' | 'review' | 'done'

const EMPLOYEES = [
  { id: 'ceo', name: 'CEO', color: 'from-violet-500 to-purple-600' },
  { id: 'architect', name: 'Architect', color: 'from-blue-500 to-cyan-600' },
  { id: 'designer', name: 'Designer', color: 'from-pink-500 to-rose-600' },
  { id: 'security', name: 'Security', color: 'from-red-500 to-orange-600' },
]

interface TeamOption {
  id: string
  name: string
  hasBuilder: boolean
}

interface TaskItem {
  id: string
  name: string
  instruction: string | null
  status: string
  executorType: string
  executorId: string | null
  context: {
    source?: 'chat_suggested' | 'reminder' | 'report' | 'chained' | 'suggestion' | 'manual' | 'security_scan' | 'code_health'
    parentTaskId?: string
    report?: Record<string, unknown>
    conversationSummary?: string
  }
  accumulatedContext: {
    model?: string
    intent?: 'build' | 'analyze_fix' | 'conversation'
    result?: {
      summary?: string
      filesTouched?: string[]
      completedAt?: string
      suggestionsCount?: number
    }
    failReason?: string
    pausedState?: Record<string, unknown>
  }
  isRecurring: boolean
  recurrenceConfig: { intervalDays?: number } | null
  queuePosition: number | null
  scheduledAt: string | null
  originalScheduledAt: string | null
  rescheduledReason: string | null
  rescheduledCount: number
  createdAt: string
}

// ── Main Panel ─────────────────────────────────────────────────────────────

export function TasksPanel({ projectId }: { projectId: string }) {
  const [doneFilter, setDoneFilter] = useState<DoneFilter>('all')
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [teams, setTeams] = useState<TeamOption[]>([])
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCreateTask, setShowCreateTask] = useState(false)
  const [showSecurityScan, setShowSecurityScan] = useState(false)
  const [showCodeHealth, setShowCodeHealth] = useState(false)
  const [showRecurringManager, setShowRecurringManager] = useState(false)

  // ── MOCK DATA (remove after testing) ──────────────────────────────────
  const MOCK_TASKS: TaskItem[] = [
    {
      id: 'mock-1',
      name: 'Implement dark mode toggle for settings page',
      instruction: null,
      status: 'pending',
      executorType: 'no_skill',
      executorId: null,
      context: {
        source: 'report' as const,
        report: {
          type: 'team_build',
          mode: 'team',
          timestamp: '2026-03-24T14:30:00.000Z',
          question: 'Add a dark mode toggle to the settings page so users can switch themes',
          etapas: [
            {
              name: 'Architecture',
              objective: 'Define component structure and state management for theme switching',
              steps: [
                { employee: 'CEO', role: 'Planner', input: 'Add dark mode toggle to settings', output: 'CEO: This is a high-value UX feature. Go ahead — scope is clear, low risk. Make sure it persists across sessions using localStorage or DB.', decision: null },
                { employee: 'Architect', role: 'Planner', input: 'CEO approved. Define architecture.', output: 'Architect: Create ThemeProvider context wrapping the app. Store preference in localStorage with DB sync. Files: lib/theme.ts, components/ThemeProvider.tsx, components/SettingsToggle.tsx. Use CSS variables for colors.', decision: null },
                { employee: 'Security', role: 'Reviewer', input: 'Architecture plan from Architect', output: 'Security: APPROVED. No security concerns — localStorage for theme is fine. Ensure no XSS via theme value injection. Sanitize the stored value to only accept "light" | "dark".', decision: 'approved' as const },
              ],
              status: 'completed',
            },
          ],
          build: {
            executor: 'Builder',
            filesChanged: [
              { path: 'lib/theme.ts', action: 'write' as const },
              { path: 'components/ThemeProvider.tsx', action: 'write' as const },
              { path: 'components/SettingsToggle.tsx', action: 'write' as const },
              { path: 'app/layout.tsx', action: 'write' as const },
            ],
            toolCalls: [
              { tool: 'read_file', path: 'app/layout.tsx', action: 'read_file → app/layout.tsx' },
              { tool: 'write_file', path: 'lib/theme.ts', action: 'write_file → lib/theme.ts' },
              { tool: 'write_file', path: 'components/ThemeProvider.tsx', action: 'write_file → components/ThemeProvider.tsx' },
              { tool: 'write_file', path: 'components/SettingsToggle.tsx', action: 'write_file → components/SettingsToggle.tsx' },
              { tool: 'write_file', path: 'app/layout.tsx', action: 'write_file → app/layout.tsx' },
            ],
            reasoning: 'Need ThemeProvider context at root level, toggle component in settings, CSS variables for theme colors.',
            summary: 'Created theme system with ThemeProvider context, localStorage persistence, and SettingsToggle component. Updated layout to wrap app with provider.',
            iterationCount: 5,
          },
          conclusion: 'Team Conclusion: Dark mode toggle implemented with ThemeProvider context, CSS variables, and localStorage persistence. Security approved — value sanitized to light|dark only.',
          model: 'sonnet',
          totalDurationMs: 34200,
        },
        conversationSummary: '=== Conversation Summary ===\nUser wants to add dark mode to the settings page. Discussed using CSS variables vs Tailwind dark class. Decided on CSS variables for flexibility. Theme should persist via localStorage with optional DB sync for cross-device.\n\n=== Recent Messages ===\nuser: I want to add a dark mode toggle to settings\n\nclaude: Great idea. Should we use CSS variables or Tailwind dark class?\n\nuser: CSS variables for more flexibility\n\nclaude: Perfect. Want me to build this now or create a task for later?\n\nuser: create a task',
      },
      accumulatedContext: {},
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
    },
    {
      id: 'mock-2',
      name: 'Add rate limiting to API endpoints',
      instruction: null,
      status: 'pending',
      executorType: 'no_skill',
      executorId: null,
      context: {
        source: 'chat_suggested' as const,
        conversationSummary: '=== Conversation Summary ===\nDiscussed security improvements for the API layer. User asked about best practices for protecting public endpoints. Covered authentication, CORS, and rate limiting. Claude identified that rate limiting is missing entirely and suggested creating a task.\n\n=== Recent Messages ===\nuser: What security do we have on our API routes?\n\nclaude: Currently you have session-based auth and CORS configured. However, there is no rate limiting on any endpoint — a single client could hammer the API with unlimited requests.\n\nuser: That sounds bad\n\nclaude: It is. I\'d recommend adding rate limiting with something like upstash/ratelimit or a simple in-memory sliding window. Want me to build this now, or create a task to handle it later?\n\nuser: task for later\n\nclaude: I\'ll create a task for that.\n\nuser: What else should we look at?\n\nclaude: Input validation on all POST/PATCH routes. You have some but it\'s inconsistent.',
      },
      accumulatedContext: {},
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    },
    {
      id: 'mock-7',
      name: 'Add loading skeletons to dashboard cards',
      instruction: null,
      status: 'pending',
      executorType: 'no_skill',
      executorId: null,
      context: {
        source: 'reminder' as const,
      },
      accumulatedContext: {},
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 2).toISOString(),
    },
    {
      id: 'mock-8',
      name: 'Follow-up: Implement user avatar upload with S3',
      instruction: null,
      status: 'pending',
      executorType: 'no_skill',
      executorId: null,
      context: {
        source: 'chained' as const,
        parentTaskId: 'mock-done-3',
        report: {
          parentTaskId: 'mock-done-3',
          parentTaskName: 'Implement user avatar upload with S3',
          steps: [
            { employee: 'CEO', output: 'CEO: Good feature for user engagement. Keep it simple — S3 + resize. Go.', approved: null },
            { employee: 'Architect', output: 'Architect: Use presigned S3 URLs for direct upload from browser. Resize server-side with sharp. Store URL in User model.', approved: null },
            { employee: 'Builder', output: 'Builder: Created S3 upload system with presigned URLs, server-side resize with sharp, and AvatarUpload component integrated into SettingsModal.', approved: null },
          ],
          filesTouched: ['lib/s3.ts', 'app/api/upload/route.ts', 'components/AvatarUpload.tsx', 'components/SettingsModal.tsx'],
          conclusion: 'Builder: Successfully implemented user avatar upload system. Created lib/s3.ts, app/api/upload/route.ts, components/AvatarUpload.tsx. Updated components/SettingsModal.tsx.',
          completedAt: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
        },
        conversationSummary: 'Previous task implemented avatar upload with S3 presigned URLs, 200x200 server-side resize with sharp, and a drag & drop AvatarUpload component. Architecture: browser uploads directly to S3 via presigned URL, server gets callback, resizes, saves URL to user profile. Files created: lib/s3.ts (S3 client), app/api/upload/route.ts (upload endpoint), components/AvatarUpload.tsx (UI component). Integrated into SettingsModal. Security approved the approach.',
      },
      accumulatedContext: {},
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 1).toISOString(),
    },
    {
      id: 'mock-3',
      name: 'Implement dark mode toggle for settings page',
      instruction: 'Create a ThemeProvider context, localStorage persistence, and a toggle component in the settings page.',
      status: 'queue',
      executorType: 'team',
      executorId: 'mock-team-1',
      context: {
        source: 'report' as const,
        report: {
          type: 'team_build',
          mode: 'team',
          timestamp: '2026-03-24T14:30:00.000Z',
          question: 'Add a dark mode toggle to the settings page so users can switch themes',
          etapas: [{
            name: 'Architecture',
            objective: 'Define theme system',
            steps: [
              { employee: 'CEO', role: 'Planner', input: 'Add dark mode', output: 'CEO: Go ahead, clear scope.', decision: null },
              { employee: 'Architect', role: 'Planner', input: 'Plan', output: 'Architect: ThemeProvider + CSS vars + localStorage.', decision: null },
            ],
            status: 'completed',
          }],
          build: {
            executor: 'Builder',
            filesChanged: [
              { path: 'lib/theme.ts', action: 'write' as const },
              { path: 'components/ThemeProvider.tsx', action: 'write' as const },
            ],
            toolCalls: [],
            reasoning: 'Theme system with provider and toggle.',
            summary: 'Created ThemeProvider + toggle with localStorage.',
            iterationCount: 3,
          },
          conclusion: 'Dark mode implemented with CSS variables and localStorage persistence.',
          model: 'sonnet',
          totalDurationMs: 34200,
        },
        conversationSummary: 'User wants dark mode in settings. Decided on CSS variables for flexibility.',
      },
      accumulatedContext: { model: 'sonnet', intent: 'build' as const },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: '2026-03-26T14:00:00.000Z',
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    },
    {
      id: 'mock-4',
      name: 'Add rate limiting to API endpoints',
      instruction: 'Implement rate limiting using upstash/ratelimit on all public API routes.',
      status: 'queue',
      executorType: 'skill',
      executorId: 'architect',
      context: {
        source: 'chat_suggested' as const,
        conversationSummary: 'Discussed API security. No rate limiting exists. Recommended upstash/ratelimit.',
      },
      accumulatedContext: { model: 'opus', intent: 'analyze_fix' as const },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: 0,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
    },
    {
      id: 'mock-5',
      name: 'Refactor authentication middleware to support JWT',
      instruction: 'Replace HMAC session cookies with JWT tokens. Update middleware, login, and all protected routes.',
      status: 'queue',
      executorType: 'team',
      executorId: 'mock-team-1',
      context: {
        source: 'chat_suggested' as const,
        conversationSummary: '=== Conversation Summary ===\nDiscussed auth architecture. Current HMAC cookies work but JWT would enable stateless auth, easier mobile support, and third-party integrations.\n\n=== Recent Messages ===\nuser: Our auth is HMAC cookies right?\n\nclaude: Yes, HMAC-SHA256 session cookies with 30-day expiry.\n\nuser: Would JWT be better for mobile?\n\nclaude: Definitely — JWT is stateless, works across platforms. Want me to build this now or create a task?\n\nuser: task for later',
      },
      accumulatedContext: { model: 'sonnet', intent: 'build' as const },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: '2026-03-27T10:00:00.000Z',
      originalScheduledAt: '2026-03-27T09:00:00.000Z',
      rescheduledReason: 'You were active at the scheduled time',
      rescheduledCount: 1,
      createdAt: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    },
    {
      id: 'mock-6',
      name: 'Check if Stripe webhook signatures are verified',
      instruction: 'Review all Stripe webhook handlers and ensure signature verification is in place.',
      status: 'queue',
      executorType: 'skill',
      executorId: 'security',
      context: {
        source: 'reminder' as const,
      },
      accumulatedContext: { model: 'haiku', intent: 'conversation' as const },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: 1,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 3).toISOString(),
    },
    // ── DONE MOCKS ──
    {
      id: 'mock-done-1',
      name: 'Buy domain for landing page',
      instruction: 'Buy domain for landing page',
      status: 'done',
      executorType: 'no_skill',
      executorId: null,
      context: { source: 'reminder' as const },
      accumulatedContext: {},
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
    },
    {
      id: 'mock-done-2',
      name: 'Security audit on authentication endpoints',
      instruction: 'Review all auth endpoints for OWASP Top 10 vulnerabilities, check token handling, session management, and input validation.',
      status: 'completed',
      executorType: 'skill',
      executorId: 'security',
      context: {
        source: 'chat_suggested' as const,
        conversationSummary: 'Discussed adding rate limiting. Claude identified auth endpoints need a security review before going to production.',
      },
      accumulatedContext: {
        model: 'sonnet',
        intent: 'conversation' as const,
        result: {
          summary: 'Security: I\'ve completed a thorough review of all authentication endpoints.\n\n**Findings:**\n\n1. **HIGH — Session token in URL params** (GET /api/auth/verify?token=xxx): Tokens should never be in URLs — they get logged in server access logs and browser history. Move to Authorization header.\n\n2. **MEDIUM — No rate limiting on login**: The /api/auth/login endpoint has no rate limiting. An attacker could brute-force credentials. Recommend: max 5 attempts per 15 minutes per IP.\n\n3. **MEDIUM — Password reset token doesn\'t expire**: Reset tokens remain valid indefinitely. Set a 1-hour expiration.\n\n4. **LOW — CORS too permissive**: CORS allows all origins in development. Ensure production locks this down to your domain only.\n\n**Overall:** 1 high, 2 medium, 1 low. The session token in URL is the most critical — fix before launch.',
          filesTouched: [],
          completedAt: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
          suggestionsCount: 3,
        },
      },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
    },
    {
      id: 'mock-done-3',
      name: 'Implement user avatar upload with S3',
      instruction: 'Add avatar upload to user settings. Store in S3, save URL in user profile. Resize to 200x200.',
      status: 'completed',
      executorType: 'team',
      executorId: 'mock-team-1',
      context: {
        source: 'report' as const,
        report: {
          type: 'team_build',
          mode: 'team',
          timestamp: '2026-03-25T10:00:00.000Z',
          question: 'How should we handle user avatars?',
          etapas: [{
            name: 'Planning',
            objective: 'Define avatar upload architecture',
            steps: [
              { employee: 'CEO', role: 'Planner', input: 'Avatar upload', output: 'CEO: Good feature for user engagement. Keep it simple — S3 + resize. Go.', decision: null },
              { employee: 'Architect', role: 'Planner', input: 'CEO approved', output: 'Architect: Use presigned S3 URLs for direct upload from browser. Resize server-side with sharp. Store URL in User model. Files: lib/s3.ts, api/upload/route.ts, components/AvatarUpload.tsx.', decision: null },
            ],
            status: 'completed',
          }],
          build: {
            executor: 'Builder',
            filesChanged: [
              { path: 'lib/s3.ts', action: 'write' as const },
              { path: 'app/api/upload/route.ts', action: 'write' as const },
              { path: 'components/AvatarUpload.tsx', action: 'write' as const },
              { path: 'components/SettingsModal.tsx', action: 'write' as const },
            ],
            toolCalls: [
              { tool: 'read_file', path: 'components/SettingsModal.tsx', action: 'read_file → components/SettingsModal.tsx' },
              { tool: 'write_file', path: 'lib/s3.ts', action: 'write_file → lib/s3.ts' },
              { tool: 'write_file', path: 'app/api/upload/route.ts', action: 'write_file → app/api/upload/route.ts' },
              { tool: 'write_file', path: 'components/AvatarUpload.tsx', action: 'write_file → components/AvatarUpload.tsx' },
              { tool: 'write_file', path: 'components/SettingsModal.tsx', action: 'write_file → components/SettingsModal.tsx' },
            ],
            reasoning: 'Need S3 client, upload API with presigned URLs, avatar component, and integration into settings.',
            summary: 'Created S3 upload system with presigned URLs, server-side resize with sharp, and AvatarUpload component integrated into SettingsModal.',
            iterationCount: 5,
          },
          conclusion: 'Avatar upload implemented with S3 presigned URLs, 200x200 resize, and settings integration.',
          model: 'sonnet',
          totalDurationMs: 67000,
        },
        conversationSummary: 'User wanted avatar upload. Discussed S3 vs local storage. Decided S3 with presigned URLs for security.',
      },
      accumulatedContext: {
        model: 'sonnet',
        intent: 'build' as const,
        result: {
          summary: 'Builder: Successfully implemented user avatar upload system.\n\n**What was done:**\n- Created `lib/s3.ts` — S3 client with presigned URL generation\n- Created `app/api/upload/route.ts` — Upload endpoint that generates presigned URL, receives callback after upload, resizes to 200x200 with sharp, saves URL to user profile\n- Created `components/AvatarUpload.tsx` — Drag & drop avatar component with preview, crop circle, and upload progress\n- Updated `components/SettingsModal.tsx` — Integrated AvatarUpload into user settings\n\n**Files touched:** lib/s3.ts, app/api/upload/route.ts, components/AvatarUpload.tsx, components/SettingsModal.tsx\n\nThe upload flow: user drops image → browser uploads directly to S3 via presigned URL → server gets notified → resizes to 200x200 → saves final URL to user profile.',
          filesTouched: ['lib/s3.ts', 'app/api/upload/route.ts', 'components/AvatarUpload.tsx', 'components/SettingsModal.tsx'],
          completedAt: new Date(Date.now() - 1000 * 60 * 20).toISOString(),
        },
      },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
    },
    {
      id: 'mock-done-4',
      name: 'Add loading skeletons to dashboard cards',
      instruction: 'Add shimmer skeleton loading states to all dashboard stat cards and the activity feed while data loads.',
      status: 'completed',
      executorType: 'skill',
      executorId: 'designer',
      context: {
        source: 'reminder' as const,
      },
      accumulatedContext: {
        model: 'haiku',
        intent: 'build' as const,
        result: {
          summary: 'Designer: Implemented loading skeletons for the dashboard.\n\n**What was done:**\n- Created `components/Skeleton.tsx` — reusable shimmer skeleton component with configurable width, height, and border radius\n- Updated `components/StatCard.tsx` — added skeleton variant that shows while data is loading, matches exact dimensions of the real card\n- Updated `components/ActivityFeed.tsx` — added 5 skeleton rows with staggered widths for natural appearance\n- Used CSS animation `@keyframes shimmer` with a subtle gradient sweep from left to right\n\n**Files touched:** components/Skeleton.tsx, components/StatCard.tsx, components/ActivityFeed.tsx, app/globals.css\n\nThe skeletons match the exact layout of the real components so there\'s zero layout shift when data loads.',
          filesTouched: ['components/Skeleton.tsx', 'components/StatCard.tsx', 'components/ActivityFeed.tsx', 'app/globals.css'],
          completedAt: new Date(Date.now() - 1000 * 60 * 10).toISOString(),
        },
      },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
    },
    {
      id: 'mock-done-5',
      name: 'Fix broken pagination on projects list API',
      instruction: 'Add cursor-based pagination to GET /api/projects. Return max 20 per page with nextCursor.',
      status: 'done',
      executorType: 'team',
      executorId: 'mock-team-1',
      context: {
        source: 'chat_suggested' as const,
        conversationSummary: 'User reported the projects list was loading all projects at once. Discussed pagination strategies — decided on cursor-based for performance. Claude suggested creating a task.',
      },
      accumulatedContext: {
        model: 'sonnet',
        intent: 'build' as const,
        result: {
          summary: 'Builder: Successfully implemented cursor-based pagination on the projects list API.\n\n**What was done:**\n- Updated `app/api/projects/route.ts` — Added cursor parameter, limit to 20, returns `nextCursor` in response\n- Updated `components/ProjectList.tsx` — Added infinite scroll with intersection observer, loads next page automatically\n- Updated `lib/db.ts` — Added `paginateQuery` helper for reusable cursor pagination\n\n**Files touched:** app/api/projects/route.ts, components/ProjectList.tsx, lib/db.ts\n\nPagination uses the project `createdAt` + `id` as cursor for stable ordering. Response format: `{ projects: [...], nextCursor: "..." | null }`.',
          filesTouched: ['app/api/projects/route.ts', 'components/ProjectList.tsx', 'lib/db.ts'],
          completedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
          suggestionsCount: 1,
        },
      },
      isRecurring: false,
      recurrenceConfig: null,
      queuePosition: null,
      scheduledAt: null,
      originalScheduledAt: null,
      rescheduledReason: null,
      rescheduledCount: 0,
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 6).toISOString(),
    },
  ]
  // ── END MOCK DATA ───────────────────────────────────────────────────────

  useEffect(() => {
    fetch(`/api/projects/${projectId}/tasks`)
      .then((r) => r.json())
      .then((data) => {
        setTasks([...MOCK_TASKS, ...(data.tasks ?? [])])
        setTeams(data.teams ?? [])
        setLoading(false)
      })
      .catch(() => { setTasks(MOCK_TASKS); setLoading(false) })
  }, [projectId])

  const doneTasks = tasks.filter((t) => {
    if (t.status !== 'done' && t.status !== 'completed') return false
    if (doneFilter === 'review') return t.status === 'completed'
    if (doneFilter === 'done') return t.status === 'done'
    return true
  })
  const pendingTasks = tasks.filter((t) => t.status === 'pending')
  const queueTasks = tasks.filter((t) => t.status === 'queue').sort((a, b) => (a.queuePosition ?? 999) - (b.queuePosition ?? 999))
  const anytimeTasks = queueTasks.filter((t) => !t.scheduledAt)

  const [queueStatus, setQueueStatus] = useState<'running' | 'paused'>('paused')
  const [reorderMode, setReorderMode] = useState(false)
  const [showQueueInfo, setShowQueueInfo] = useState(false)
  const [togglingQueue, setTogglingQueue] = useState(false)

  // Fetch queue status
  useEffect(() => {
    fetch(`/api/projects/${projectId}/queue`)
      .then((r) => r.json())
      .then((data) => { if (data.queueStatus) setQueueStatus(data.queueStatus) })
      .catch(() => {})
  }, [projectId])

  async function toggleQueue() {
    const next = queueStatus === 'running' ? 'paused' : 'running'
    setTogglingQueue(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/queue`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueStatus: next }),
      })
      if (res.ok) setQueueStatus(next)
    } catch {}
    setTogglingQueue(false)
  }

  function handleReorderSaved(reorderedIds: string[]) {
    const newTasks = tasks.map((t) => {
      const pos = reorderedIds.indexOf(t.id)
      if (pos !== -1) return { ...t, queuePosition: pos }
      return t
    })
    setTasks(newTasks)
    setReorderMode(false)
  }

  function handleTaskUpdated(updated: TaskItem) {
    setTasks((prev) => prev.map((t) => t.id === updated.id ? updated : t))
    setSelectedTask(null)
  }

  function handleTaskDeleted(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id))
    setSelectedTask(null)
  }

  const DONE_FILTERS: { id: DoneFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'review', label: 'To Review' },
    { id: 'done', label: 'Approved' },
  ]

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Sub-navbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-5 py-1.5" style={{ backgroundColor: '#1e1e28' }}>
        {/* Create Task */}
        <div className="relative group">
          <button
            onClick={() => setShowCreateTask(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-violet-500/30 bg-violet-500/10 transition-all hover:border-violet-500/50 hover:bg-violet-500/20"
          >
            <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </button>
          <div className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-72 rounded-lg border border-white/10 p-4 opacity-0 shadow-xl transition-opacity group-hover:opacity-100" style={{ backgroundColor: '#15151c' }}>
            <p className="text-[11px] font-semibold text-zinc-100">Create Task</p>
            <div className="mt-2 space-y-2 text-[10px] leading-relaxed text-zinc-400">
              <p><span className="text-violet-400 font-medium">New task:</span> Define a task from scratch — name, instructions, upload context files (PDF, code, docs), choose who executes, select model.</p>
              <p><span className="text-zinc-300 font-medium">Schedule:</span> Run once (anytime or fixed date) or set up recurring runs (every X days). Goes straight to the queue.</p>
            </div>
          </div>
        </div>

        {/* Security Scan */}
        <div className="relative group">
          <button
            onClick={() => setShowSecurityScan(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 transition-all hover:border-red-500/50 hover:bg-red-500/20"
          >
            <svg className="h-4 w-4 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
          </button>
          <div className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-72 rounded-lg border border-white/10 p-4 opacity-0 shadow-xl transition-opacity group-hover:opacity-100" style={{ backgroundColor: '#15151c' }}>
            <p className="text-[11px] font-semibold text-zinc-100">Security Scan</p>
            <div className="mt-2 space-y-2 text-[10px] leading-relaxed text-zinc-400">
              <p><span className="text-red-400 font-medium">Full Scan:</span> Comprehensive audit — OWASP Top 10, STRIDE, secret detection, dependency vulnerabilities, auth review, injection vectors.</p>
              <p><span className="text-amber-400 font-medium">Targeted:</span> Same enterprise security context focused on a specific area you define.</p>
              <p><span className="text-zinc-300 font-medium">Recommended:</span> Opus model, weekly recurring.</p>
            </div>
          </div>
        </div>

        {/* Code Health */}
        <div className="relative group">
          <button
            onClick={() => setShowCodeHealth(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/10 transition-all hover:border-emerald-500/50 hover:bg-emerald-500/20"
          >
            <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
            </svg>
          </button>
          <div className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-72 rounded-lg border border-white/10 p-4 opacity-0 shadow-xl transition-opacity group-hover:opacity-100" style={{ backgroundColor: '#15151c' }}>
            <p className="text-[11px] font-semibold text-zinc-100">Code Health</p>
            <div className="mt-2 space-y-2 text-[10px] leading-relaxed text-zinc-400">
              <p><span className="text-emerald-400 font-medium">Full Analysis:</span> Comprehensive health check — dead code, complexity, type safety, naming, duplication, tech debt, dependencies, architecture smells. Grades A-F.</p>
              <p><span className="text-amber-400 font-medium">Targeted:</span> Same depth focused on a specific module, component, or area you choose.</p>
              <p><span className="text-zinc-300 font-medium">Recommended:</span> Sonnet model, bi-weekly recurring for continuous health monitoring.</p>
            </div>
          </div>
        </div>

        {/* Recurring Manager */}
        <div className="relative group">
          <button
            onClick={() => setShowRecurringManager(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-500/30 bg-cyan-500/10 transition-all hover:border-cyan-500/50 hover:bg-cyan-500/20"
          >
            <svg className="h-4 w-4 text-cyan-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
          </button>
          <div className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-72 rounded-lg border border-white/10 p-4 opacity-0 shadow-xl transition-opacity group-hover:opacity-100" style={{ backgroundColor: '#15151c' }}>
            <p className="text-[11px] font-semibold text-zinc-100">Recurring Tasks</p>
            <div className="mt-2 space-y-2 text-[10px] leading-relaxed text-zinc-400">
              <p><span className="text-cyan-400 font-medium">All recurring:</span> View every task set to run on a schedule — manual tasks, security scans, or any other recurring work. All in one place.</p>
              <p><span className="text-zinc-300 font-medium">Manage:</span> Skip the next run, change interval, or stop a recurring task permanently. Each run is independent — no context carried between executions.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left 70% — 3 task columns */}
        <div className="flex min-h-0 w-[70%] flex-col border-r border-white/10">
          {/* Column headers */}
          <div className="flex shrink-0 border-b border-white/10" style={{ backgroundColor: '#15151c' }}>
            <div className="flex flex-1 items-center gap-2 border-r border-white/10 px-4 py-2.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-xs font-semibold text-zinc-300">Done</span>
              <div className="ml-auto flex items-center gap-1">
                {DONE_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setDoneFilter(f.id)}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-all ${
                      doneFilter === f.id
                        ? 'bg-white/10 text-zinc-200'
                        : 'text-zinc-500 hover:text-zinc-400'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-1 items-center gap-2 border-r border-white/10 px-4 py-2.5">
              <span className="h-2 w-2 rounded-full bg-blue-500" />
              <span className="text-xs font-semibold text-zinc-300">Pending</span>
              {pendingTasks.length > 0 && (
                <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">{pendingTasks.length}</span>
              )}
            </div>
            <div className="flex flex-1 items-center gap-2 px-4 py-2.5">
              <span className={`h-2 w-2 rounded-full ${queueStatus === 'running' ? 'bg-emerald-500 animate-pulse' : 'bg-violet-500'}`} />
              <span className="text-xs font-semibold text-zinc-300">In Queue</span>
              {queueTasks.length > 0 && (
                <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-400">{queueTasks.length}</span>
              )}
              <div className="ml-auto flex items-center gap-1">
                {/* Info */}
                <div
                  className="relative"
                  onMouseEnter={() => setShowQueueInfo(true)}
                  onMouseLeave={() => setShowQueueInfo(false)}
                >
                  <div className="flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-zinc-600 hover:bg-white/5 hover:text-zinc-400 cursor-default">
                    i
                  </div>
                  {showQueueInfo && (
                    <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-lg border border-white/10 p-4 shadow-xl" style={{ backgroundColor: '#15151c' }}>
                      <p className="text-[11px] font-semibold text-zinc-200 mb-2">How the queue works</p>
                      <div className="space-y-1.5 text-[10px] leading-relaxed text-zinc-400">
                        <p><span className="text-emerald-400 font-medium">Auto-start:</span> If no activity is detected for 30 minutes, the queue starts running tasks automatically.</p>
                        <p><span className="text-violet-400 font-medium">Manual start:</span> Click "Start" to begin running tasks immediately. Click "Pause" to stop after the current task finishes.</p>
                        <p><span className="text-sky-400 font-medium">Run Now:</span> Open any task and click "Run Now" to execute it immediately. After it finishes, the queue continues if you remain idle for 15 minutes.</p>
                        <p><span className="text-amber-400 font-medium">Scheduled tasks:</span> Run at their exact time, jumping ahead of the queue. If an anytime task is about to start but a scheduled one is within 15 min, it waits.</p>
                        <p><span className="text-zinc-300 font-medium">Priority:</span> Anytime tasks run in order — drag to reorder. Scheduled tasks always run at their set time regardless of position.</p>
                        <p><span className="text-red-400 font-medium">Auto-pause:</span> When you send a message in the chat, the queue pauses after the current task finishes. The repository can only be used by one source at a time.</p>
                        <p><span className="text-zinc-300 font-medium">Repository lock:</span> While a task modifies files, you can still chat, analyze, and discuss — but builds from the chat are blocked until the task completes.</p>
                      </div>
                    </div>
                  )}
                </div>
                {/* Reorder toggle */}
                {anytimeTasks.length > 1 && (
                  <button
                    onClick={() => setReorderMode(!reorderMode)}
                    title="Reorder priority"
                    className={`flex h-5 w-5 items-center justify-center rounded text-[10px] transition-all ${
                      reorderMode ? 'bg-violet-500/20 text-violet-300' : 'text-zinc-600 hover:text-zinc-400'
                    }`}
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
                    </svg>
                  </button>
                )}
                {/* Start/Pause Queue */}
                <button
                  onClick={toggleQueue}
                  disabled={togglingQueue || queueTasks.length === 0}
                  title={queueStatus === 'running' ? 'Pause queue' : 'Start queue'}
                  className={`flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium transition-all disabled:opacity-30 ${
                    queueStatus === 'running'
                      ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                      : 'bg-white/5 text-zinc-500 hover:bg-white/10 hover:text-zinc-300'
                  }`}
                >
                  {queueStatus === 'running' ? (
                    <>
                      <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 24 24">
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
                      </svg>
                      <span>Start</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* Column bodies */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto border-r border-white/10 p-3" style={{ backgroundColor: '#1e1e28' }}>
              {loading && <LoadingPlaceholder />}
              {!loading && doneTasks.length === 0 && <EmptyCol label="No tasks here yet" />}
              {doneTasks.map((t) => <DoneCard key={t.id} task={t} teams={teams} onClick={() => setSelectedTask(t)} />)}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto border-r border-white/10 p-3" style={{ backgroundColor: '#1e1e28' }}>
              {loading && <LoadingPlaceholder />}
              {!loading && pendingTasks.length === 0 && <EmptyCol label="No pending tasks" />}
              {pendingTasks.map((t) => <TaskCard key={t.id} task={t} onClick={() => setSelectedTask(t)} />)}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3" style={{ backgroundColor: '#1e1e28' }}>
              {loading && <LoadingPlaceholder />}
              {!loading && queueTasks.length === 0 && <EmptyCol label="No queued tasks" />}
              {queueTasks.map((t) => <QueueCard key={t.id} task={t} teams={teams} onClick={() => setSelectedTask(t)} />)}
            </div>
          </div>
        </div>

        {/* Right 30% — Live task viewer */}
        <div className="flex w-[30%] flex-col" style={{ backgroundColor: '#15151c' }}>
          <TaskRunnerViewer projectId={projectId} />
        </div>
      </div>

      {/* Modals — route by status + source */}
      {selectedTask && selectedTask.status === 'queue' && (
        <QueueDetailModal
          task={selectedTask}
          projectId={projectId}
          teams={teams}
          onClose={() => setSelectedTask(null)}
          onUpdated={handleTaskUpdated}
          onDeleted={handleTaskDeleted}
        />
      )}
      {selectedTask && selectedTask.status === 'pending' && selectedTask.context?.source === 'reminder' && (
        <ReminderDetailModal
          task={selectedTask}
          projectId={projectId}
          teams={teams}
          onClose={() => setSelectedTask(null)}
          onUpdated={handleTaskUpdated}
          onDeleted={handleTaskDeleted}
        />
      )}
      {selectedTask && selectedTask.status === 'pending' && selectedTask.context?.source !== 'reminder' && (
        <TaskDetailModal
          task={selectedTask}
          projectId={projectId}
          teams={teams}
          onClose={() => setSelectedTask(null)}
          onUpdated={handleTaskUpdated}
          onDeleted={handleTaskDeleted}
        />
      )}
      {selectedTask && selectedTask.status === 'done' && selectedTask.context?.source === 'reminder' && !selectedTask.accumulatedContext?.result && (
        <DoneReminderModal
          task={selectedTask}
          onClose={() => setSelectedTask(null)}
        />
      )}
      {selectedTask && (selectedTask.status === 'done' || selectedTask.status === 'completed') && !(selectedTask.status === 'done' && selectedTask.context?.source === 'reminder' && !selectedTask.accumulatedContext?.result) && (
        <DoneTaskReviewModal
          task={selectedTask}
          projectId={projectId}
          teams={teams}
          onClose={() => setSelectedTask(null)}
          onUpdated={handleTaskUpdated}
        />
      )}

      {/* Reorder modal */}
      {reorderMode && (
        <ReorderModal
          tasks={anytimeTasks}
          projectId={projectId}
          teams={teams}
          onSave={handleReorderSaved}
          onClose={() => setReorderMode(false)}
        />
      )}

      {/* Create task modal */}
      {showCreateTask && (
        <CreateTaskModal
          projectId={projectId}
          teams={teams}
          onCreated={(newTask) => { setTasks((prev) => [newTask, ...prev]); setShowCreateTask(false) }}
          onClose={() => setShowCreateTask(false)}
        />
      )}

      {/* Recurring manager modal */}
      {showRecurringManager && (
        <ManageRecurringModal
          projectId={projectId}
          tasks={tasks.filter((t) => t.isRecurring)}
          teams={teams}
          onUpdated={(updated) => setTasks((prev) => prev.map((t) => t.id === updated.id ? updated : t))}
          onDeleted={(id) => setTasks((prev) => prev.filter((t) => t.id !== id))}
          onClose={() => setShowRecurringManager(false)}
        />
      )}

      {/* Code health modal */}
      {showCodeHealth && (
        <CodeHealthModal
          projectId={projectId}
          teams={teams}
          onCreated={(newTask) => { setTasks((prev) => [newTask, ...prev]); setShowCodeHealth(false) }}
          onClose={() => setShowCodeHealth(false)}
        />
      )}

      {/* Security scan modal */}
      {showSecurityScan && (
        <SecurityScanModal
          projectId={projectId}
          teams={teams}
          onCreated={(newTask) => { setTasks((prev) => [newTask, ...prev]); setShowSecurityScan(false) }}
          onClose={() => setShowSecurityScan(false)}
        />
      )}
    </div>
  )
}

// ── Task Card ──────────────────────────────────────────────────────────────

const STATUS_CARD_STYLES: Record<string, { border: string; bg: string; hover: string; title: string }> = {
  pending:   { border: 'border-sky-500/25', bg: 'bg-sky-500/[0.06]', hover: 'hover:border-sky-500/40 hover:bg-sky-500/[0.1]', title: 'text-sky-200' },
  done:      { border: 'border-emerald-500/25', bg: 'bg-emerald-500/[0.06]', hover: 'hover:border-emerald-500/40 hover:bg-emerald-500/[0.1]', title: 'text-emerald-200' },
  completed: { border: 'border-emerald-500/25', bg: 'bg-emerald-500/[0.06]', hover: 'hover:border-emerald-500/40 hover:bg-emerald-500/[0.1]', title: 'text-emerald-200' },
  queue:     { border: 'border-violet-500/25', bg: 'bg-violet-500/[0.06]', hover: 'hover:border-violet-500/40 hover:bg-violet-500/[0.1]', title: 'text-violet-200' },
}

function TaskCard({ task, onClick }: { task: TaskItem; onClick?: () => void }) {
  const hasReport = !!task.context?.report
  const isReminder = task.context?.source === 'reminder'
  const timeAgo = getTimeAgo(task.createdAt)
  const style = STATUS_CARD_STYLES[task.status] ?? STATUS_CARD_STYLES.pending

  return (
    <button
      onClick={onClick}
      className={`w-full shrink-0 rounded-lg border ${style.border} ${style.bg} p-3 text-left transition-all ${style.hover}`}
    >
      <div className="flex items-center gap-1.5">
        {isReminder && (
          <svg className="h-3 w-3 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
        )}
        <p className={`text-xs font-medium ${style.title} line-clamp-2`}>{task.name}</p>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10px] text-zinc-500">{timeAgo}</span>
        {isReminder && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">reminder</span>
        )}
        {task.context?.source === 'chained' && (
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-medium text-cyan-400">retask</span>
        )}
        {task.context?.source === 'suggestion' && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">suggestion</span>
        )}
        {task.context?.source === 'manual' && !task.isRecurring && (
          <span className="rounded bg-zinc-500/15 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">manual</span>
        )}
        {task.context?.source === 'security_scan' && (
          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-400">security</span>
        )}
        {task.context?.source === 'code_health' && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">health</span>
        )}
        {task.isRecurring && (
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-medium text-cyan-400">recurring</span>
        )}
        {hasReport && !isReminder && task.context?.source !== 'chained' && (
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium text-violet-400">report</span>
        )}
        {task.scheduledAt && (
          <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-medium text-blue-400">scheduled</span>
        )}
      </div>
      {onClick && (
        <p className="mt-1 text-[10px] text-zinc-600">Click to manage</p>
      )}
    </button>
  )
}

// ── Task Detail Modal ──────────────────────────────────────────────────────

function TaskDetailModal({
  task,
  projectId,
  teams,
  onClose,
  onUpdated,
  onDeleted,
}: {
  task: TaskItem
  projectId: string
  teams: TeamOption[]
  onClose: () => void
  onUpdated: (t: TaskItem) => void
  onDeleted: (id: string) => void
}) {
  const [step, setStep] = useState<'detail' | 'schedule'>('detail')
  const [instruction, setInstruction] = useState(task.instruction ?? '')
  const [executorType, setExecutorType] = useState<'skill' | 'team'>(task.executorType === 'team' ? 'team' : 'skill')
  const [executorId, setExecutorId] = useState(task.executorId ?? '')
  const [model, setModel] = useState('sonnet')
  const [submitting, setSubmitting] = useState(false)
  const [showReportModal, setShowReportModal] = useState(false)
  const [showContextModal, setShowContextModal] = useState(false)
  const [taskIntent, setTaskIntent] = useState<'build' | 'analyze_fix' | 'conversation'>('build')
  const [hoveredInfo, setHoveredInfo] = useState<string | null>(null)

  async function handleDelete() {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) onDeleted(task.id)
    } catch { /* ignore */ }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report = task.context?.report as any
  const conversationSummary = task.context?.conversationSummary

  function handleConfirm() {
    setStep('schedule')
  }

  async function handleSchedule(scheduleType: 'anytime' | 'fixed', scheduledAt?: string) {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: instruction.trim() || null,
          executorType,
          executorId: executorId || null,
          status: 'queue',
          scheduledAt: scheduleType === 'fixed' ? scheduledAt : null,
          accumulatedContext: { model, intent: taskIntent },
        }),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  if (step === 'schedule') {
    return (
      <ScheduleModal
        model={model}
        onModelChange={setModel}
        onConfirm={handleSchedule}
        onBack={() => setStep('detail')}
        onClose={onClose}
        submitting={submitting}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1a1a22' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Task Details</h2>
            <p className="text-[11px] text-zinc-500">Created {new Date(task.createdAt).toLocaleString()}</p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-6 space-y-4">
          {/* Report (clickable preview → opens full modal) */}
          {report && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Attached Report</p>
              <button
                onClick={() => setShowReportModal(true)}
                className="flex w-full items-center gap-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] p-3 text-left transition-all hover:border-violet-500/40 hover:bg-violet-500/[0.1]"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/20">
                  <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-violet-300 truncate">
                    {(report as Record<string, unknown>).parentTaskName
                      ? `Execution Report: ${String((report as Record<string, unknown>).parentTaskName)}`
                      : String((report as Record<string, unknown>).type) === 'team_build' ? 'Team Build Report'
                      : String((report as Record<string, unknown>).type) === 'team_discussion' ? 'Team Report'
                      : 'Build Report'}
                  </p>
                  <p className="text-[10px] text-zinc-500 truncate">{String((report as Record<string, unknown>).question ?? (report as Record<string, unknown>).conclusion ?? '')}</p>
                </div>
                <svg className="h-3.5 w-3.5 shrink-0 text-zinc-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </button>
            </div>
          )}

          {/* Context (clickable preview → opens full modal) */}
          {conversationSummary && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Conversation Context</p>
              <button
                onClick={() => setShowContextModal(true)}
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-3 text-left transition-all hover:border-white/15 hover:bg-white/[0.05]"
              >
                <p className="text-[11px] leading-relaxed text-zinc-400 line-clamp-3">{conversationSummary}</p>
                <p className="mt-1.5 text-[10px] text-zinc-600">Click to read full context</p>
              </button>
            </div>
          )}

          {/* Instruction (editable) */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">What should be done</p>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="Describe what this task should accomplish..."
              rows={3}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-violet-500/50 focus:outline-none"
            />
          </div>

          {/* Task intent */}
          <TaskIntentSelector
            value={taskIntent}
            onChange={setTaskIntent}
            hoveredInfo={hoveredInfo}
            onHoverInfo={setHoveredInfo}
          />

          {/* Executor selection */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Assign to</p>
            {/* Type toggle */}
            <div className="flex gap-2 mb-2">
              <button
                onClick={() => { setExecutorType('skill'); setExecutorId('') }}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                  executorType === 'skill'
                    ? 'border-violet-500/50 bg-violet-500/10 text-violet-300'
                    : 'border-white/10 text-zinc-500 hover:border-white/20 hover:text-zinc-400'
                }`}
              >
                Employee
              </button>
              <button
                onClick={() => { setExecutorType('team'); setExecutorId('') }}
                className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                  executorType === 'team'
                    ? 'border-violet-500/50 bg-violet-500/10 text-violet-300'
                    : 'border-white/10 text-zinc-500 hover:border-white/20 hover:text-zinc-400'
                }`}
              >
                Team
              </button>
            </div>
            {/* Selection list */}
            {executorType === 'skill' ? (
              <div className="grid grid-cols-2 gap-1.5">
                {EMPLOYEES.map((emp) => (
                  <button
                    key={emp.id}
                    onClick={() => setExecutorId(emp.id)}
                    className={`rounded-lg bg-gradient-to-br ${emp.color} px-3 py-2 text-left transition-all ${
                      executorId === emp.id ? 'ring-2 ring-white/40 shadow-lg' : 'opacity-50 hover:opacity-80'
                    }`}
                  >
                    <p className="text-xs font-semibold text-white">{emp.name}</p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                {teams.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">No teams created yet. Create teams in My Team.</p>
                ) : (
                  teams.map((team) => (
                    <button
                      key={team.id}
                      onClick={() => setExecutorId(team.id)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all ${
                        executorId === team.id
                          ? 'border-violet-500/50 bg-violet-500/10'
                          : 'border-white/10 hover:border-white/20'
                      }`}
                    >
                      <span className={`text-xs font-medium ${executorId === team.id ? 'text-violet-300' : 'text-zinc-400'}`}>
                        {team.name}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        {/* Builder warning */}
        <BuilderWarning intent={taskIntent} executorType={executorType} executorId={executorId} teams={teams} />

        {/* Footer */}
        <div className="flex gap-3 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <button
            onClick={handleConfirm}
            disabled={!instruction.trim() || !executorId}
            className="flex h-9 flex-1 items-center justify-center rounded-lg bg-violet-600 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30"
          >
            Continue
          </button>
          <button
            onClick={onClose}
            className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={handleDelete}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
            title="Delete task"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      {/* Report overlay modal */}
      {showReportModal && report && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => setShowReportModal(false)}>
          <div
            className="relative max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
            style={{ backgroundColor: '#1a1a22' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/20">
                  <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">
                    {report.type === 'team_discussion' ? 'Team Discussion Report' : report.type === 'team_build' ? 'Team Build Report' : 'Build Report'}
                  </h2>
                  <p className="text-[11px] text-zinc-500">{new Date(report.timestamp).toLocaleString()} · {report.model ?? 'sonnet'}</p>
                </div>
              </div>
              <button onClick={() => setShowReportModal(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto p-6 space-y-4" style={{ maxHeight: 'calc(85vh - 72px)' }}>
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Request</p>
                <p className="text-sm text-zinc-300">{report.question}</p>
              </div>
              {report.etapas && report.etapas.length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Pipeline — {report.etapas.length} stages</p>
                  {(report.etapas as any[]).map((etapa: any, i: number) => (
                    <div key={i} className="mb-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                      <p className="text-xs font-semibold text-zinc-200">{etapa.name}</p>
                      <p className="text-[10px] text-zinc-500">{etapa.objective}</p>
                      {(etapa.steps as any[]).map((s: any, si: number) => (
                        <div key={si} className="mt-2 border-t border-white/5 pt-2">
                          <p className="text-[10px] font-semibold text-zinc-400">{s.employee} <span className="text-zinc-600">({s.role})</span></p>
                          <p className="mt-0.5 text-[11px] text-zinc-500 whitespace-pre-wrap">{s.output}</p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {report.build && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Build — {report.build.filesChanged.length} files</p>
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-1">
                    {(report.build.filesChanged as any[]).map((f: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-[11px]">
                        <span className={`font-mono ${f.action === 'delete' ? 'text-red-400' : 'text-emerald-400'}`}>{f.action === 'delete' ? 'D' : 'M'}</span>
                        <span className="text-zinc-300">{f.path}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                    <p className="text-[10px] font-semibold text-zinc-500 mb-1">Summary</p>
                    <p className="whitespace-pre-wrap text-[11px] text-zinc-400">{report.build.summary}</p>
                  </div>
                </div>
              )}
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Conclusion</p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{report.conclusion}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Context overlay modal */}
      {showContextModal && conversationSummary && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => setShowContextModal(false)}>
          <div
            className="relative max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
            style={{ backgroundColor: '#1a1a22' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h2 className="text-sm font-semibold text-zinc-100">Conversation Context</h2>
              <button onClick={() => setShowContextModal(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="overflow-y-auto p-6" style={{ maxHeight: 'calc(80vh - 64px)' }}>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-300">{conversationSummary}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Schedule Modal ─────────────────────────────────────────────────────────

// ── Reminder Detail Modal ──────────────────────────────────────────────────

function ReminderDetailModal({
  task,
  projectId,
  teams,
  onClose,
  onUpdated,
  onDeleted,
}: {
  task: TaskItem
  projectId: string
  teams: TeamOption[]
  onClose: () => void
  onUpdated: (t: TaskItem) => void
  onDeleted: (id: string) => void
}) {
  const [mode, setMode] = useState<'view' | 'to-task' | 'schedule'>('view')
  const [instruction, setInstruction] = useState('')
  const [taskIntent, setTaskIntent] = useState<'build' | 'analyze_fix' | 'conversation'>('build')
  const [hoveredInfo, setHoveredInfo] = useState<string | null>(null)
  const [executorType, setExecutorType] = useState<'skill' | 'team'>('skill')
  const [executorId, setExecutorId] = useState('')
  const [model, setModel] = useState('sonnet')
  const [submitting, setSubmitting] = useState(false)

  async function handleDelete() {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) onDeleted(task.id)
    } catch { /* ignore */ }
  }

  async function handleMarkDone() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  async function handleSchedule(scheduleType: 'anytime' | 'fixed', scheduledAt?: string) {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: instruction.trim() || null,
          executorType,
          executorId: executorId || null,
          status: 'queue',
          scheduledAt: scheduleType === 'fixed' ? scheduledAt : null,
          accumulatedContext: { model, intent: taskIntent },
        }),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  // Schedule step
  if (mode === 'schedule') {
    return (
      <ScheduleModal
        model={model}
        onModelChange={setModel}
        onConfirm={handleSchedule}
        onBack={() => setMode('to-task')}
        onClose={onClose}
        submitting={submitting}
      />
    )
  }

  // Convert to task step
  if (mode === 'to-task') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
        <div
          className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
          style={{ backgroundColor: '#1a1a22' }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Convert to Task</h2>
              <p className="text-[11px] text-zinc-500">From reminder: {task.name}</p>
            </div>
            <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-6 space-y-4">
            {/* What should be done */}
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">What should be done</p>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="Describe what this task should accomplish..."
                rows={3}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-violet-500/50 focus:outline-none"
              />
            </div>

            {/* Task intent */}
            <TaskIntentSelector
              value={taskIntent}
              onChange={setTaskIntent}
              hoveredInfo={hoveredInfo}
              onHoverInfo={setHoveredInfo}
            />

            {/* Executor */}
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Assign to</p>
              <div className="flex gap-2 mb-2">
                <button
                  onClick={() => { setExecutorType('skill'); setExecutorId('') }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                    executorType === 'skill'
                      ? 'border-violet-500/50 bg-violet-500/10 text-violet-300'
                      : 'border-white/10 text-zinc-500 hover:border-white/20 hover:text-zinc-400'
                  }`}
                >
                  Employee
                </button>
                <button
                  onClick={() => { setExecutorType('team'); setExecutorId('') }}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
                    executorType === 'team'
                      ? 'border-violet-500/50 bg-violet-500/10 text-violet-300'
                      : 'border-white/10 text-zinc-500 hover:border-white/20 hover:text-zinc-400'
                  }`}
                >
                  Team
                </button>
              </div>
              {executorType === 'skill' ? (
                <div className="grid grid-cols-2 gap-1.5">
                  {EMPLOYEES.map((emp) => (
                    <button
                      key={emp.id}
                      onClick={() => setExecutorId(emp.id)}
                      className={`rounded-lg bg-gradient-to-br ${emp.color} px-3 py-2 text-left transition-all ${
                        executorId === emp.id ? 'ring-2 ring-white/40 shadow-lg' : 'opacity-50 hover:opacity-80'
                      }`}
                    >
                      <p className="text-xs font-semibold text-white">{emp.name}</p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {teams.length === 0 ? (
                    <p className="text-[11px] text-zinc-600">No teams created yet.</p>
                  ) : (
                    teams.map((team) => (
                      <button
                        key={team.id}
                        onClick={() => setExecutorId(team.id)}
                        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all ${
                          executorId === team.id
                            ? 'border-violet-500/50 bg-violet-500/10'
                            : 'border-white/10 hover:border-white/20'
                        }`}
                      >
                        <span className={`text-xs font-medium ${executorId === team.id ? 'text-violet-300' : 'text-zinc-400'}`}>
                          {team.name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Builder warning */}
          <BuilderWarning intent={taskIntent} executorType={executorType} executorId={executorId} teams={teams} />

          <div className="flex gap-3 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
            <button
              onClick={() => setMode('schedule')}
              disabled={!instruction.trim() || !executorId}
              className="flex h-9 flex-1 items-center justify-center rounded-lg bg-violet-600 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30"
            >
              Continue
            </button>
            <button
              onClick={() => setMode('view')}
              className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Default: view reminder
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1a1a22' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
            </svg>
            <h2 className="text-sm font-semibold text-zinc-100">Reminder</h2>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {/* Reminder text (read-only) */}
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm text-zinc-200">{task.instruction ?? task.name}</p>
          </div>
          <p className="mt-2 text-[10px] text-zinc-600">{new Date(task.createdAt).toLocaleString()}</p>
        </div>

        {/* Actions */}
        <div className="flex gap-2 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <button
            onClick={handleMarkDone}
            disabled={submitting}
            className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            {submitting ? 'Done...' : 'Mark as Done'}
          </button>
          <button
            onClick={() => setMode('to-task')}
            className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 text-xs font-medium text-white transition-colors hover:bg-violet-500"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Create Task
          </button>
          <button
            onClick={handleDelete}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
            title="Delete reminder"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Schedule Modal ─────────────────────────────────────────────────────────

function ScheduleModal({
  model,
  onModelChange,
  onConfirm,
  onBack,
  onClose,
  submitting,
}: {
  model: string
  onModelChange: (m: string) => void
  onConfirm: (type: 'anytime' | 'fixed', scheduledAt?: string) => void
  onBack: () => void
  onClose: () => void
  submitting: boolean
}) {
  const now = new Date()
  const [scheduleType, setScheduleType] = useState<'anytime' | 'fixed'>('anytime')
  const [month, setMonth] = useState(String(now.getMonth()))
  const [day, setDay] = useState('')
  const [year, setYear] = useState(String(now.getFullYear()))
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('00')
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM')

  const MODELS = [
    { id: 'haiku', label: 'Haiku', desc: 'Fast, cheap' },
    { id: 'sonnet', label: 'Sonnet', desc: 'Balanced' },
    { id: 'opus', label: 'Opus', desc: 'Most capable' },
  ]

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const isDateComplete = month !== '' && day !== '' && year !== ''

  // Smart date validation — no past dates/times
  const nowYear = now.getFullYear()
  const nowMonth = now.getMonth()
  const nowDay = now.getDate()
  const nowHour = now.getHours()

  const selectedYear = parseInt(year)
  const selectedMonth = parseInt(month)
  const selectedDay = parseInt(day)

  function isMonthDisabled(m: number): boolean {
    return selectedYear === nowYear && m < nowMonth
  }

  function isDayDisabled(d: number): boolean {
    if (selectedYear > nowYear) return false
    if (selectedYear === nowYear && selectedMonth > nowMonth) return false
    if (selectedYear === nowYear && selectedMonth === nowMonth) return d < nowDay
    return true
  }

  const isToday = selectedYear === nowYear && selectedMonth === nowMonth && selectedDay === nowDay

  function isHourDisabled(h12: number, p: 'AM' | 'PM'): boolean {
    if (!isToday) return false
    const h24 = p === 'AM' ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12)
    return h24 < nowHour
  }

  function isMinuteDisabled(min: string): boolean {
    if (!isToday) return false
    const h24 = period === 'AM' ? (parseInt(hour) === 12 ? 0 : parseInt(hour)) : (parseInt(hour) === 12 ? 12 : parseInt(hour) + 12)
    if (h24 > nowHour) return false
    if (h24 === nowHour) return parseInt(min) <= now.getMinutes()
    return true
  }

  function handleConfirm() {
    if (scheduleType === 'fixed' && isDateComplete) {
      const h24 = period === 'AM'
        ? (hour === '12' ? 0 : parseInt(hour))
        : (hour === '12' ? 12 : parseInt(hour) + 12)
      const iso = `${year}-${String(parseInt(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${String(h24).padStart(2, '0')}:${minute}:00.000Z`
      onConfirm('fixed', iso)
    } else {
      onConfirm('anytime')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1a1a22' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <h2 className="text-sm font-semibold text-zinc-100">Model & Schedule</h2>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4 p-6">
          {/* Model selector */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Model</p>
            <div className="flex gap-2">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => onModelChange(m.id)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-left transition-all ${
                    model === m.id
                      ? 'border-violet-500/50 bg-violet-500/10'
                      : 'border-white/10 hover:border-white/20'
                  }`}
                >
                  <p className={`text-xs font-medium ${model === m.id ? 'text-violet-300' : 'text-zinc-400'}`}>{m.label}</p>
                  <p className="text-[10px] text-zinc-600">{m.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">When to run</p>
            <div className="space-y-2">
              <button
                onClick={() => setScheduleType('anytime')}
                className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all ${
                  scheduleType === 'anytime'
                    ? 'border-violet-500/50 bg-violet-500/10'
                    : 'border-white/10 hover:border-white/20'
                }`}
              >
                <div className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                  scheduleType === 'anytime' ? 'border-violet-500 bg-violet-500' : 'border-zinc-600'
                }`}>
                  {scheduleType === 'anytime' && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                </div>
                <div>
                  <p className={`text-xs font-medium ${scheduleType === 'anytime' ? 'text-violet-300' : 'text-zinc-400'}`}>Anytime</p>
                  <p className="text-[10px] text-zinc-600">Enters the queue and runs when available</p>
                </div>
              </button>

              <button
                onClick={() => setScheduleType('fixed')}
                className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all ${
                  scheduleType === 'fixed'
                    ? 'border-violet-500/50 bg-violet-500/10'
                    : 'border-white/10 hover:border-white/20'
                }`}
              >
                <div className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                  scheduleType === 'fixed' ? 'border-violet-500 bg-violet-500' : 'border-zinc-600'
                }`}>
                  {scheduleType === 'fixed' && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                </div>
                <div>
                  <p className={`text-xs font-medium ${scheduleType === 'fixed' ? 'text-violet-300' : 'text-zinc-400'}`}>Scheduled</p>
                  <p className="text-[10px] text-zinc-600">Pick a specific date and time</p>
                </div>
              </button>

              {scheduleType === 'fixed' && (
                <div className="space-y-3 pl-7">
                  {/* Month & Year row */}
                  <div className="flex items-center gap-2">
                    <div className="flex overflow-hidden rounded-lg border border-white/10">
                      {MONTHS.map((m, i) => {
                        const disabled = isMonthDisabled(i)
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => !disabled && setMonth(String(i))}
                            className={`px-2 py-1.5 text-[10px] font-medium transition-all ${
                              disabled
                                ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed'
                                : month === String(i) ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-zinc-600 hover:text-zinc-400'
                            }`}
                          >
                            {m}
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex overflow-hidden rounded-lg border border-white/10">
                      {[2026, 2027, 2028].map((y) => (
                        <button
                          key={y}
                          type="button"
                          onClick={() => setYear(String(y))}
                          className={`px-2.5 py-1.5 text-[10px] font-medium transition-all ${
                            year === String(y) ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-zinc-600 hover:text-zinc-400'
                          }`}
                        >
                          {y}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Day grid */}
                  <div>
                    <p className="mb-1 text-[10px] text-zinc-600">Day</p>
                    <div className="grid grid-cols-7 gap-1">
                      {Array.from({ length: 31 }, (_, i) => {
                        const d = String(i + 1).padStart(2, '0')
                        const selected = day === d
                        const disabled = isDayDisabled(i + 1)
                        const today = selectedYear === nowYear && selectedMonth === nowMonth && i + 1 === nowDay
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => !disabled && setDay(d)}
                            className={`flex h-7 items-center justify-center rounded-md text-[11px] font-medium transition-all ${
                              disabled
                                ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed'
                                : selected
                                  ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30'
                                  : today
                                    ? 'bg-white/10 text-violet-400 ring-1 ring-violet-500/30'
                                    : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'
                            }`}
                          >
                            {i + 1}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  {/* Time picker */}
                  <div>
                    <p className="mb-1 text-[10px] text-zinc-600">Time</p>
                    <div className="flex items-center gap-2">
                      {/* Hour */}
                      <div className="grid grid-cols-6 gap-1">
                        {Array.from({ length: 12 }, (_, i) => {
                          const h = String(i + 1)
                          const disabled = isHourDisabled(i + 1, period)
                          return (
                            <button
                              key={h}
                              type="button"
                              onClick={() => !disabled && setHour(h)}
                              className={`flex h-7 w-8 items-center justify-center rounded-md text-[11px] font-medium transition-all ${
                                disabled
                                  ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed'
                                  : hour === h
                                    ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30'
                                    : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'
                              }`}
                            >
                              {h}
                            </button>
                          )
                        })}
                      </div>

                      <span className="text-sm font-bold text-zinc-500">:</span>

                      {/* Minute */}
                      <div className="flex flex-col gap-1">
                        {['00', '15', '30', '45'].map((m) => {
                          const disabled = isMinuteDisabled(m)
                          return (
                            <button
                              key={m}
                              type="button"
                              onClick={() => !disabled && setMinute(m)}
                              className={`flex h-7 w-10 items-center justify-center rounded-md text-[11px] font-medium transition-all ${
                                disabled
                                  ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed'
                                  : minute === m
                                    ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30'
                                    : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'
                              }`}
                            >
                              {m}
                            </button>
                          )
                        })}
                      </div>

                      {/* AM/PM */}
                      <div className="flex flex-col gap-1">
                        {(['AM', 'PM'] as const).map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setPeriod(p)}
                            className={`flex h-7 w-10 items-center justify-center rounded-md text-[11px] font-semibold transition-all ${
                              period === p
                                ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30'
                                : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'
                            }`}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <button
            onClick={handleConfirm}
            disabled={submitting || (scheduleType === 'fixed' && !isDateComplete)}
            className="flex h-9 flex-1 items-center justify-center rounded-lg bg-violet-600 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30"
          >
            {submitting ? (
              <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : 'Send to Queue'}
          </button>
          <button
            onClick={onBack}
            className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Schedule Picker (reusable) ─────────────────────────────────────────────

const SP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function SchedulePicker({
  month, setMonth, day, setDay, year, setYear,
  hour, setHour, minute, setMinute, period, setPeriod,
  accentColor = 'violet',
}: {
  month: string; setMonth: (v: string) => void
  day: string; setDay: (v: string) => void
  year: string; setYear: (v: string) => void
  hour: string; setHour: (v: string) => void
  minute: string; setMinute: (v: string) => void
  period: 'AM' | 'PM'; setPeriod: (v: 'AM' | 'PM') => void
  accentColor?: 'violet' | 'red' | 'emerald'
}) {
  const now = new Date()
  const nowYear = now.getFullYear()
  const nowMonth = now.getMonth()
  const nowDay = now.getDate()
  const nowHour = now.getHours()

  const selYear = parseInt(year)
  const selMonth = parseInt(month)
  const selDay = parseInt(day)
  const isToday = selYear === nowYear && selMonth === nowMonth && selDay === nowDay

  function isMonthDisabled(m: number) { return selYear === nowYear && m < nowMonth }
  function isDayDisabled(d: number) {
    if (selYear > nowYear) return false
    if (selYear === nowYear && selMonth > nowMonth) return false
    if (selYear === nowYear && selMonth === nowMonth) return d < nowDay
    return true
  }
  function isHourDisabled(h12: number, p: 'AM' | 'PM') {
    if (!isToday) return false
    const h24 = p === 'AM' ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12)
    return h24 < nowHour
  }

  function isMinuteDisabled(min: string) {
    if (!isToday) return false
    const selH24 = period === 'AM' ? (parseInt(hour) === 12 ? 0 : parseInt(hour)) : (parseInt(hour) === 12 ? 12 : parseInt(hour) + 12)
    if (selH24 > nowHour) return false
    if (selH24 === nowHour) return parseInt(min) <= now.getMinutes()
    return true
  }

  function isPeriodDisabled(p: 'AM' | 'PM') {
    if (!isToday) return false
    if (p === 'AM' && nowHour >= 12) return true
    return false
  }

  const ac = {
    violet: { selected: 'bg-violet-500 text-white shadow-sm shadow-violet-500/30', monthSel: 'bg-violet-500/20 text-violet-300', today: 'bg-white/10 text-violet-400 ring-1 ring-violet-500/30' },
    red: { selected: 'bg-red-500 text-white shadow-sm shadow-red-500/30', monthSel: 'bg-red-500/20 text-red-300', today: 'bg-white/10 text-red-400 ring-1 ring-red-500/30' },
    emerald: { selected: 'bg-emerald-500 text-white shadow-sm shadow-emerald-500/30', monthSel: 'bg-emerald-500/20 text-emerald-300', today: 'bg-white/10 text-emerald-400 ring-1 ring-emerald-500/30' },
  }[accentColor]

  return (
    <div className="space-y-3">
      {/* Month & Year */}
      <div className="flex items-center gap-2">
        <div className="flex overflow-hidden rounded-lg border border-white/10">
          {SP_MONTHS.map((m, i) => {
            const disabled = isMonthDisabled(i)
            return <button key={m} type="button" onClick={() => !disabled && setMonth(String(i))} className={`px-2 py-1.5 text-[10px] font-medium transition-all ${disabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : month === String(i) ? ac.monthSel : 'bg-white/5 text-zinc-600 hover:text-zinc-400'}`}>{m}</button>
          })}
        </div>
        <div className="flex overflow-hidden rounded-lg border border-white/10">
          {[2026, 2027, 2028].map((y) => <button key={y} type="button" onClick={() => setYear(String(y))} className={`px-2.5 py-1.5 text-[10px] font-medium transition-all ${year === String(y) ? ac.monthSel : 'bg-white/5 text-zinc-600 hover:text-zinc-400'}`}>{y}</button>)}
        </div>
      </div>

      {/* Day grid */}
      <div>
        <p className="mb-1 text-[10px] text-zinc-600">Day</p>
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 31 }, (_, i) => {
            const d = String(i + 1).padStart(2, '0')
            const disabled = isDayDisabled(i + 1)
            const todayMark = selYear === nowYear && selMonth === nowMonth && i + 1 === nowDay
            return <button key={d} type="button" onClick={() => !disabled && setDay(d)} className={`flex h-7 items-center justify-center rounded-md text-[11px] font-medium transition-all ${disabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : day === d ? ac.selected : todayMark ? ac.today : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{i + 1}</button>
          })}
        </div>
      </div>

      {/* Time */}
      <div>
        <p className="mb-1 text-[10px] text-zinc-600">Time</p>
        <div className="flex items-center gap-2">
          <div className="grid grid-cols-6 gap-1">
            {Array.from({ length: 12 }, (_, i) => {
              const h = String(i + 1)
              const disabled = isHourDisabled(i + 1, period)
              return <button key={h} type="button" onClick={() => !disabled && setHour(h)} className={`flex h-7 w-8 items-center justify-center rounded-md text-[11px] font-medium transition-all ${disabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : hour === h ? ac.selected : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{h}</button>
            })}
          </div>
          <span className="text-sm font-bold text-zinc-500">:</span>
          <div className="flex flex-col gap-1">
            {['00', '15', '30', '45'].map((m) => {
              const mDisabled = isMinuteDisabled(m)
              return <button key={m} type="button" onClick={() => !mDisabled && setMinute(m)} className={`flex h-7 w-10 items-center justify-center rounded-md text-[11px] font-medium transition-all ${mDisabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : minute === m ? ac.selected : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{m}</button>
            })}
          </div>
          <div className="flex flex-col gap-1">
            {(['AM', 'PM'] as const).map((p) => {
              const pDisabled = isPeriodDisabled(p)
              return <button key={p} type="button" onClick={() => !pDisabled && setPeriod(p)} className={`flex h-7 w-10 items-center justify-center rounded-md text-[11px] font-semibold transition-all ${pDisabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : period === p ? ac.selected : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{p}</button>
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Builder Warning ────────────────────────────────────────────────────────

function BuilderWarning({ intent, executorType, executorId, teams }: {
  intent: 'build' | 'analyze_fix' | 'conversation'
  executorType: 'skill' | 'team'
  executorId: string
  teams: TeamOption[]
}) {
  if (intent === 'conversation') return null
  if (executorType !== 'team') return null
  if (!executorId) return null

  const team = teams.find((t) => t.id === executorId)
  if (!team || team.hasBuilder) return null

  return (
    <div className="mx-6 mb-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <div className="flex items-start gap-2">
        <svg className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <div>
          <p className="text-xs font-medium text-amber-300">This team has no Builder</p>
          <p className="mt-0.5 text-[11px] text-amber-400/80">
            {intent === 'build'
              ? 'Build tasks require a team with a Builder to write code. Switch to an employee or a team that includes a Builder.'
              : 'Analyze & Fix may need to write code if issues are found. Consider using a team with a Builder, or switch to Review & Discuss if no code changes are needed.'}
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Done Card ──────────────────────────────────────────────────────────────

function DoneCard({ task, teams, onClick }: { task: TaskItem; teams: TeamOption[]; onClick: () => void }) {
  const isReminder = task.context?.source === 'reminder' && !task.accumulatedContext?.result
  const isAwaitingReview = task.status === 'completed'
  const timeAgo = getTimeAgo(task.createdAt)
  const completedAt = task.accumulatedContext?.result?.completedAt
  const executorName = getExecutorName(task, teams)
  const model = task.accumulatedContext?.model
  const intent = INTENT_LABELS[task.accumulatedContext?.intent ?? '']
  const suggestionsCount = task.accumulatedContext?.result?.suggestionsCount ?? 0

  const style = isAwaitingReview
    ? { border: 'border-amber-500/25', bg: 'bg-amber-500/[0.06]', hover: 'hover:border-amber-500/40 hover:bg-amber-500/[0.1]', title: 'text-amber-200' }
    : STATUS_CARD_STYLES.done ?? STATUS_CARD_STYLES.pending

  return (
    <button
      onClick={onClick}
      className={`w-full shrink-0 rounded-lg border ${style.border} ${style.bg} p-3 text-left transition-all ${style.hover}`}
    >
      <div className="flex items-center gap-1.5">
        {isReminder && (
          <svg className="h-3 w-3 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
          </svg>
        )}
        {!isReminder && isAwaitingReview && (
          <svg className="h-3 w-3 shrink-0 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        )}
        {!isReminder && !isAwaitingReview && (
          <svg className="h-3 w-3 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        )}
        <p className={`text-xs font-medium ${style.title} line-clamp-2`}>{task.name}</p>
      </div>
      {/* Executor + intent + model for tasks */}
      {isAwaitingReview && !isReminder && (
        <div className="mt-1.5 flex items-center gap-2">
          <div className="flex items-center gap-1">
            <svg className="h-3 w-3 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
            </svg>
            <span className="text-[10px] font-medium text-zinc-300">{executorName}</span>
          </div>
          {intent && <span className={`text-[9px] font-medium ${intent.color}`}>{intent.label}</span>}
          {model && <span className="text-[10px] text-zinc-600">{model}</span>}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {isReminder && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">reminder</span>
        )}
        {isAwaitingReview && !isReminder && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">awaiting review</span>
        )}
        {!isAwaitingReview && !isReminder && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">reviewed</span>
        )}
        {task.isRecurring && (
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-medium text-cyan-400">recurring</span>
        )}
        {task.context?.source === 'manual' && !task.isRecurring && (
          <span className="rounded bg-zinc-500/15 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">manual</span>
        )}
        {task.context?.source === 'security_scan' && (
          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-400">security</span>
        )}
        {task.context?.source === 'code_health' && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">health</span>
        )}
        {completedAt && (
          <span className="text-[10px] text-zinc-500">{getTimeAgo(completedAt)}</span>
        )}
        {!completedAt && <span className="text-[10px] text-zinc-600">{timeAgo}</span>}
      </div>
      {isAwaitingReview && !isReminder && (
        <div className="mt-1 flex items-center gap-2">
          <p className="text-[10px] text-amber-400/70">Click to review</p>
          {suggestionsCount > 0 && (
            <span className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
              <svg className="h-2.5 w-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
              </svg>
              {suggestionsCount}
            </span>
          )}
        </div>
      )}
    </button>
  )
}

// ── Done Reminder Modal ────────────────────────────────────────────────────

function DoneReminderModal({ task, onClose }: { task: TaskItem; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div className="flex items-center gap-2">
            <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
            <h2 className="text-sm font-semibold text-zinc-100">Reminder Completed</h2>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="p-6">
          <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
            <p className="text-sm text-zinc-200">{task.instruction ?? task.name}</p>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">reminder</span>
            <span className="text-[10px] text-zinc-500">Marked as done {getTimeAgo(task.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Done Task Review Modal ─────────────────────────────────────────────────

function DoneTaskReviewModal({
  task,
  projectId,
  teams,
  onClose,
  onUpdated,
}: {
  task: TaskItem
  projectId: string
  teams: TeamOption[]
  onClose: () => void
  onUpdated: (t: TaskItem) => void
}) {
  const [showReportModal, setShowReportModal] = useState(false)
  const [showContextModal, setShowContextModal] = useState(false)
  const [showExecutionReport, setShowExecutionReport] = useState(false)
  const [creatingRetask, setCreatingRetask] = useState(false)
  const [retaskCreated, setRetaskCreated] = useState(false)
  const [suggestions, setSuggestions] = useState<{ id: string; suggestionText: string; reason: string | null; accepted: boolean }[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [creatingSuggestionTask, setCreatingSuggestionTask] = useState<string | null>(null)

  // Fetch suggestions (or use mocks)
  useEffect(() => {
    if (task.id.startsWith('mock-')) {
      // Mock suggestions for mock-done-2
      if (task.id === 'mock-done-2') {
        setSuggestions([
          { id: 'sug-1', suggestionText: 'The /api/projects endpoint returns all projects without pagination — could be a performance issue with many projects', reason: 'Noticed by Security during auth review', accepted: false },
          { id: 'sug-2', suggestionText: 'Environment variables DATABASE_URL and NODE_SECRET are not validated at startup — app will crash with confusing errors if missing', reason: 'Noticed by Security during auth review', accepted: false },
          { id: 'sug-3', suggestionText: 'The middleware.ts file imports from lib/session which uses Node.js crypto — may cause issues in Edge Runtime deployments', reason: 'Noticed by Security during auth review', accepted: false },
        ])
      }
      return
    }
    fetch(`/api/projects/${projectId}/tasks/${task.id}/logs`)
      .then((r) => r.json())
      .then((data) => { if (data.suggestions) setSuggestions(data.suggestions) })
      .catch(() => {})
  }, [projectId, task.id])

  async function handleCreateTaskFromSuggestion(suggestionId: string, text: string, noticedBy: string | null) {
    setCreatingSuggestionTask(suggestionId)

    // Build context from the suggestion + parent task info
    const parentIntent = task.accumulatedContext?.intent
    const parentModel = task.accumulatedContext?.model
    const contextParts: string[] = []
    contextParts.push(`This suggestion was noticed by ${noticedBy ?? 'an employee'} while executing task "${task.name}".`)
    if (parentIntent) contextParts.push(`The task was a ${parentIntent === 'build' ? 'Build' : parentIntent === 'analyze_fix' ? 'Analyze & Fix' : 'Review & Discuss'} task${parentModel ? ` using ${parentModel}` : ''}.`)
    if (task.instruction) contextParts.push(`Original task instructions: ${task.instruction}`)
    if (result?.summary) contextParts.push(`Task conclusion: ${result.summary.slice(0, 500)}`)
    contextParts.push(`\nSuggestion: ${text}`)

    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: text.length > 80 ? text.slice(0, 80) + '...' : text,
          instruction: text,
          context: {
            source: 'suggestion',
            parentTaskId: task.id,
            conversationSummary: contextParts.join('\n\n'),
          },
        }),
      })
      if (res.ok) {
        setSuggestions((prev) => prev.map((s) => s.id === suggestionId ? { ...s, accepted: true } : s))
      }
    } catch {}
    setCreatingSuggestionTask(null)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report = task.context?.report as any
  const conversationSummary = task.context?.conversationSummary
  const executorName = getExecutorName(task, teams)
  const intent = INTENT_LABELS[task.accumulatedContext?.intent ?? '']
  const result = (task.accumulatedContext as { result?: { summary?: string; filesTouched?: string[]; completedAt?: string } })?.result
  const isAwaitingReview = task.status === 'completed'

  async function handleDeleteTask() {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) onClose()
    } catch {}
  }

  async function handleCreateRetask() {
    if (creatingRetask) return
    setCreatingRetask(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}/retask`, { method: 'POST' })
      if (res.ok) setRetaskCreated(true)
    } catch {}
    setCreatingRetask(false)
  }

  async function handleMarkReviewed() {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="flex h-[85vh] w-[92vw] max-w-7xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div>
            <div className="flex items-center gap-2">
              {isAwaitingReview ? (
                <span className="h-2 w-2 rounded-full bg-amber-500" />
              ) : (
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
              )}
              <h2 className="text-sm font-semibold text-zinc-100">{task.name}</h2>
            </div>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              {isAwaitingReview ? 'Completed — awaiting your review' : 'Reviewed and done'}
              {result?.completedAt && ` · ${getTimeAgo(result.completedAt)}`}
            </p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Two-column body */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left — Task info, context, attachments */}
          <div className="flex w-1/2 flex-col overflow-y-auto border-r border-white/10 p-6 space-y-4">
            {/* Task info bar */}
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5">
                <svg className="h-3 w-3 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                </svg>
                <span className="text-[11px] font-medium text-zinc-300">{executorName}</span>
              </div>
              {intent && <span className={`text-[10px] font-medium ${intent.color}`}>{intent.label}</span>}
              <span className="text-[10px] text-zinc-600">{task.accumulatedContext?.model ?? 'sonnet'}</span>
            </div>

            {/* Instructions */}
            {task.instruction && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Instructions</p>
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                  <p className="text-[11px] text-zinc-400">{task.instruction}</p>
                </div>
              </div>
            )}

            {/* Attached Report */}
            {report && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Attached Report</p>
                <button onClick={() => setShowReportModal(true)} className="flex w-full items-center gap-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] p-3 text-left transition-all hover:border-violet-500/40 hover:bg-violet-500/[0.1]">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/20">
                    <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-violet-300 truncate">{report.type === 'team_build' ? 'Team Build Report' : report.type === 'team_discussion' ? 'Team Report' : 'Build Report'}</p>
                    <p className="text-[10px] text-zinc-500 truncate">{report.question}</p>
                  </div>
                </button>
              </div>
            )}

            {/* Conversation Context */}
            {conversationSummary && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Conversation Context</p>
                <button onClick={() => setShowContextModal(true)} className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-3 text-left hover:border-white/15 hover:bg-white/[0.05]">
                  <p className="text-[11px] leading-relaxed text-zinc-400 line-clamp-3">{conversationSummary}</p>
                  <p className="mt-1 text-[10px] text-zinc-600">Click to read full context</p>
                </button>
              </div>
            )}

            {/* Empty state when no context */}
            {!report && !conversationSummary && !task.instruction && (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-[11px] text-zinc-600">No additional context — task was created from a reminder</p>
              </div>
            )}
          </div>

          {/* Right — Conclusion + Execution report */}
          <div className="flex w-1/2 flex-col overflow-y-auto p-6 space-y-4">
            {/* Claude's conclusion */}
            {result?.summary && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">Conclusion</p>
                <div className="max-h-56 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">{result.summary}</p>
                </div>

                {/* Files touched */}
                {result.filesTouched && result.filesTouched.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {result.filesTouched.map((f, i) => (
                      <span key={i} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-mono text-emerald-400">{f}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Execution report */}
            <div>
              <button
                onClick={() => setShowExecutionReport(true)}
                className="flex w-full items-center gap-3 rounded-lg border border-sky-500/20 bg-sky-500/[0.06] p-3 text-left transition-all hover:border-sky-500/40 hover:bg-sky-500/[0.1]"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/20">
                  <svg className="h-4 w-4 text-sky-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs font-medium text-sky-300">Execution Report</p>
                  <p className="text-[10px] text-zinc-500">Full detail of what each employee thought and did</p>
                </div>
                <svg className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </button>
            </div>

            {/* Suggestions */}
            <div>
              <button
                onClick={() => setShowSuggestions(!showSuggestions)}
                className="flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-left transition-all hover:border-white/15 hover:bg-white/[0.05]"
              >
                <svg className={`h-3.5 w-3.5 ${suggestions.length > 0 ? 'text-amber-400' : 'text-zinc-600'}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                </svg>
                <span className={`text-xs font-medium ${suggestions.length > 0 ? 'text-amber-300' : 'text-zinc-500'}`}>
                  {suggestions.length > 0 ? `${suggestions.length} suggestion${suggestions.length !== 1 ? 's' : ''}` : 'No suggestions'}
                </span>
                {suggestions.length > 0 && (
                  <svg className={`ml-auto h-3 w-3 text-zinc-500 transition-transform ${showSuggestions ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                  </svg>
                )}
              </button>

              {showSuggestions && suggestions.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {suggestions.map((s) => (
                    <div key={s.id} className="flex items-start gap-2 rounded-lg border border-amber-500/15 bg-amber-500/[0.04] p-3">
                      <svg className="h-3 w-3 shrink-0 text-amber-400 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18" />
                      </svg>
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] text-zinc-300">{s.suggestionText}</p>
                        {s.reason && <p className="mt-0.5 text-[9px] text-zinc-600">{s.reason}</p>}
                      </div>
                      {s.accepted ? (
                        <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">task created</span>
                      ) : (
                        <button
                          onClick={() => handleCreateTaskFromSuggestion(s.id, s.suggestionText, s.reason)}
                          disabled={creatingSuggestionTask === s.id}
                          className="shrink-0 rounded bg-violet-500/10 px-2 py-1 text-[9px] font-medium text-violet-400 hover:bg-violet-500/20 disabled:opacity-50"
                        >
                          {creatingSuggestionTask === s.id ? '...' : '+ Task'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!result?.summary && (
              <div className="flex flex-1 items-center justify-center">
                <p className="text-[11px] text-zinc-600">No conclusion available</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          {/* Mark as Reviewed — only in awaiting review */}
          {isAwaitingReview && (
            <button
              onClick={handleMarkReviewed}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              Mark as Reviewed
            </button>
          )}
          {/* Retask — always available */}
          {retaskCreated ? (
            <span className="flex h-9 flex-1 items-center justify-center gap-1.5 text-[11px] text-emerald-400">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
              New task created — manage in Pending
            </span>
          ) : (
            <button
              onClick={handleCreateRetask}
              disabled={creatingRetask}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-violet-500/30 text-xs font-medium text-violet-400 transition-colors hover:bg-violet-500/10 disabled:opacity-50"
            >
              {creatingRetask ? (
                <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
              ) : (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                </svg>
              )}
              {creatingRetask ? 'Creating...' : 'New Task with Context'}
            </button>
          )}
          {/* Delete — always available */}
          <button
            onClick={handleDeleteTask}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
            title="Delete task"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
          <button onClick={onClose} className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200">
            Close
          </button>
        </div>
      </div>

      {/* Report overlay */}
      {showReportModal && report && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => setShowReportModal(false)}>
          <div className="relative max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h2 className="text-sm font-semibold text-zinc-100">Attached Report</h2>
              <button onClick={() => setShowReportModal(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300"><svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>
            </div>
            <div className="overflow-y-auto p-6 space-y-4" style={{ maxHeight: 'calc(85vh - 72px)' }}>
              <div><p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Request</p><p className="text-sm text-zinc-300">{report.question}</p></div>
              {report.etapas && (report.etapas as any[]).map((etapa: any, i: number) => (
                <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
                  <p className="text-xs font-semibold text-zinc-200">{etapa.name}</p>
                  {(etapa.steps as any[])?.map((s: any, si: number) => (
                    <div key={si} className="mt-2 border-t border-white/5 pt-2">
                      <p className="text-[10px] font-semibold text-zinc-400">{s.employee}</p>
                      <p className="mt-0.5 text-[11px] text-zinc-500 whitespace-pre-wrap">{s.output}</p>
                    </div>
                  ))}
                </div>
              ))}
              {report.build && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Build — {report.build.filesChanged.length} files</p>
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-1">
                    {(report.build.filesChanged as any[]).map((f: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-[11px]">
                        <span className={`font-mono ${f.action === 'delete' ? 'text-red-400' : 'text-emerald-400'}`}>{f.action === 'delete' ? 'D' : 'M'}</span>
                        <span className="text-zinc-300">{f.path}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div><p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Conclusion</p><p className="whitespace-pre-wrap text-sm text-zinc-300">{report.conclusion}</p></div>
            </div>
          </div>
        </div>
      )}

      {/* Context overlay */}
      {showContextModal && conversationSummary && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => setShowContextModal(false)}>
          <div className="relative max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h2 className="text-sm font-semibold text-zinc-100">Conversation Context</h2>
              <button onClick={() => setShowContextModal(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300"><svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>
            </div>
            <div className="overflow-y-auto p-6" style={{ maxHeight: 'calc(80vh - 64px)' }}>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-300">{conversationSummary}</p>
            </div>
          </div>
        </div>
      )}

      {/* Execution report overlay */}
      {showExecutionReport && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => setShowExecutionReport(false)}>
          <div className="relative max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/20">
                  <svg className="h-4 w-4 text-sky-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z" /></svg>
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-zinc-100">Execution Report</h2>
                  <p className="text-[11px] text-zinc-500">{task.name}</p>
                </div>
              </div>
              <button onClick={() => setShowExecutionReport(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300"><svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg></button>
            </div>
            <ExecutionReportContent taskId={task.id} projectId={projectId} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Execution Report Content (fetches skill logs + build logs) ─────────────

function ExecutionReportContent({ taskId, projectId }: { taskId: string; projectId: string }) {
  const [logs, setLogs] = useState<{ collaboratorName: string; thoughts: string | null; conclusion: string | null; approved: boolean | null; startedAt: string; finishedAt: string | null }[]>([])
  const [buildLogs, setBuildLogs] = useState<{ filesTouched: { path: string; action: string }[]; createdAt: string }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/projects/${projectId}/tasks/running`)
      .then((r) => r.json())
      .then(() => {
        // Try fetching logs for this specific task
        return fetch(`/api/projects/${projectId}/tasks/${taskId}/logs`)
      })
      .then((r) => r.ok ? r.json() : { logs: [], buildLogs: [] })
      .then((data) => { setLogs(data.logs ?? []); setBuildLogs(data.buildLogs ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [taskId, projectId])

  const EMP_COLORS: Record<string, string> = {
    CEO: 'from-violet-500 to-purple-600', Architect: 'from-blue-500 to-cyan-600',
    Designer: 'from-pink-500 to-rose-600', Security: 'from-red-500 to-orange-600',
    Builder: 'from-red-600 to-red-700', Claude: 'from-zinc-500 to-zinc-600',
  }

  const allFiles = buildLogs.flatMap((b) => b.filesTouched)

  return (
    <div className="overflow-y-auto p-6 space-y-3" style={{ maxHeight: 'calc(85vh - 72px)' }}>
      {loading && <p className="text-xs text-zinc-500">Loading execution details...</p>}

      {!loading && logs.length === 0 && (
        <p className="text-xs text-zinc-500">No execution logs available for this task.</p>
      )}

      {logs.map((log, i) => {
        const color = EMP_COLORS[log.collaboratorName] ?? 'from-zinc-500 to-zinc-600'
        return (
          <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className={`rounded bg-gradient-to-br ${color} px-2 py-0.5 text-[9px] font-bold text-white`}>
                {log.collaboratorName}
              </span>
              {log.approved === true && <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-[8px] font-medium text-emerald-400">APPROVED</span>}
              {log.approved === false && <span className="rounded bg-red-500/20 px-1 py-0.5 text-[8px] font-medium text-red-400">REJECTED</span>}
              {log.finishedAt && <span className="text-[9px] text-zinc-600">{getTimeAgo(log.finishedAt)}</span>}
            </div>
            {log.thoughts && (
              <div className="mb-1">
                <p className="text-[9px] font-semibold uppercase text-zinc-600 mb-0.5">Thinking</p>
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-400">{log.thoughts}</p>
              </div>
            )}
            {log.conclusion && log.conclusion !== log.thoughts && (
              <div>
                <p className="text-[9px] font-semibold uppercase text-zinc-600 mb-0.5">Conclusion</p>
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-300">{log.conclusion}</p>
              </div>
            )}
          </div>
        )
      })}

      {allFiles.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
          <p className="text-[9px] font-semibold uppercase text-zinc-600 mb-1.5">Files Touched</p>
          <div className="space-y-0.5">
            {allFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className={`font-mono ${f.action === 'delete' ? 'text-red-400' : 'text-emerald-400'}`}>{f.action === 'delete' ? 'D' : 'M'}</span>
                <span className="text-zinc-300">{f.path}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Code Health Modal ──────────────────────────────────────────────────────

function CodeHealthModal({
  projectId,
  teams,
  onCreated,
  onClose,
}: {
  projectId: string
  teams: TeamOption[]
  onCreated: (task: TaskItem) => void
  onClose: () => void
}) {
  const [scanType, setScanType] = useState<'full' | 'targeted'>('full')
  const [instruction, setInstruction] = useState('')
  const [taskIntent, setTaskIntent] = useState<'analyze_fix' | 'conversation'>('conversation')
  const [executorType, setExecutorType] = useState<'skill' | 'team'>('skill')
  const [executorId, setExecutorId] = useState('architect')
  const [model, setModel] = useState('sonnet')
  const [scheduleType, setScheduleType] = useState<'anytime' | 'fixed' | 'recurring'>('anytime')
  const [intervalDays, setIntervalDays] = useState('14')
  const [submitting, setSubmitting] = useState(false)

  const now = new Date()
  const [month, setMonth] = useState(String(now.getMonth()))
  const [day, setDay] = useState('')
  const [year, setYear] = useState(String(now.getFullYear()))
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('00')
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM')
  const CH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  function getScheduledAt(): string | null {
    if (scheduleType !== 'fixed') return null
    if (!month || !day || !year) return null
    const h24 = period === 'AM' ? (hour === '12' ? 0 : parseInt(hour)) : (hour === '12' ? 12 : parseInt(hour) + 12)
    return `${year}-${String(parseInt(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${String(h24).padStart(2, '0')}:${minute}:00.000Z`
  }

  async function handleSubmit() {
    if (submitting) return
    if (scanType === 'targeted' && !instruction.trim()) return
    setSubmitting(true)

    const taskName = scanType === 'full'
      ? 'Code Health — Full Repository Analysis'
      : `Code Health — ${instruction.trim().slice(0, 60)}`

    const healthInstruction = scanType === 'full'
      ? 'Perform a comprehensive code health analysis of the entire repository. Follow the full enterprise code health context provided.'
      : instruction.trim()

    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: taskName,
          instruction: healthInstruction,
          executorType,
          executorId,
          status: 'queue',
          scheduledAt: getScheduledAt(),
          isRecurring: scheduleType === 'recurring',
          recurrenceConfig: scheduleType === 'recurring' ? { intervalDays: parseInt(intervalDays) || 14 } : undefined,
          accumulatedContext: { model, intent: taskIntent },
          context: {
            source: 'code_health',
            scanType,
            healthContext: scanType === 'full' ? 'full_analysis' : 'targeted',
          },
        }),
      })
      if (res.ok) {
        const created = await res.json()
        onCreated(created)
      }
    } catch {}
    setSubmitting(false)
  }

  const INTENT_OPTIONS: { id: 'analyze_fix' | 'conversation'; label: string; desc: string; color: string }[] = [
    { id: 'conversation', label: 'Analyze Only', desc: 'Review and report — no code changes', color: 'text-sky-300' },
    { id: 'analyze_fix', label: 'Analyze & Fix', desc: 'Find issues and clean them up', color: 'text-amber-300' },
  ]

  const canSubmit = (scanType === 'full' || instruction.trim()) && executorId

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-emerald-500/20 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-emerald-500/20 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20">
              <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Code Health</h2>
              <p className="text-[11px] text-zinc-500">Quality, maintainability & technical debt analysis</p>
            </div>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Scan type */}
          <div>
            <div className="flex gap-2">
              <button onClick={() => setScanType('full')} className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-all ${scanType === 'full' ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 hover:border-white/20'}`}>
                <p className={`text-xs font-medium ${scanType === 'full' ? 'text-emerald-300' : 'text-zinc-400'}`}>Full Analysis</p>
                <p className="text-[10px] text-zinc-600">Entire repository health check</p>
              </button>
              <button onClick={() => setScanType('targeted')} className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-all ${scanType === 'targeted' ? 'border-amber-500/50 bg-amber-500/10' : 'border-white/10 hover:border-white/20'}`}>
                <p className={`text-xs font-medium ${scanType === 'targeted' ? 'text-amber-300' : 'text-zinc-400'}`}>Targeted</p>
                <p className="text-[10px] text-zinc-600">Focus on specific area</p>
              </button>
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">
              {scanType === 'full'
                ? 'Will check dead code, complexity, type safety, naming, duplication, tech debt, dependencies, and architecture smells across the entire codebase.'
                : 'Same depth of analysis but focused on the specific module, component, or area you define below.'}
            </p>
          </div>

          {/* Health context (locked) */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Health Context</p>
            <div className="flex items-center gap-3 rounded-lg border border-emerald-500/15 bg-emerald-500/[0.04] p-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15">
                <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </div>
              <div>
                <p className="text-[11px] font-medium text-emerald-300">Enterprise Code Health Context</p>
                <p className="text-[9px] text-zinc-500">Quality · Complexity · Patterns · Debt · Dependencies · Architecture</p>
              </div>
            </div>
          </div>

          {/* Instruction */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Instructions</p>
            {scanType === 'full' ? (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <p className="text-[11px] text-zinc-600 italic">Full repository code health analysis — dead code, complexity, patterns, tech debt, dependencies, architecture</p>
              </div>
            ) : (
              <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="What should be analyzed? e.g. 'Check the components folder', 'Analyze the API routes', 'Review the auth module'..." rows={3} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-emerald-500/50 focus:outline-none" />
            )}
          </div>

          {/* Intent */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">What should happen</p>
            <div className="space-y-1.5">
              {INTENT_OPTIONS.map((opt) => (
                <button key={opt.id} onClick={() => setTaskIntent(opt.id)} className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all ${taskIntent === opt.id ? 'border-emerald-500/40 bg-emerald-500/[0.06]' : 'border-white/10 hover:border-white/20'}`}>
                  <div className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${taskIntent === opt.id ? 'border-emerald-500 bg-emerald-500' : 'border-zinc-600'}`}>
                    {taskIntent === opt.id && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </div>
                  <div>
                    <p className={`text-xs font-medium ${taskIntent === opt.id ? opt.color : 'text-zinc-400'}`}>{opt.label}</p>
                    <p className="text-[10px] text-zinc-600">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <BuilderWarning intent={taskIntent} executorType={executorType} executorId={executorId} teams={teams} />

          {/* Executor */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Assign to</p>
            <div className="flex gap-2 mb-2">
              <button onClick={() => { setExecutorType('skill'); setExecutorId('architect') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${executorType === 'skill' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Employee</button>
              <button onClick={() => { setExecutorType('team'); setExecutorId('') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${executorType === 'team' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Team</button>
            </div>
            {executorType === 'skill' ? (
              <div className="grid grid-cols-2 gap-1.5">
                {EMPLOYEES.map((emp) => (
                  <button key={emp.id} onClick={() => setExecutorId(emp.id)} className={`rounded-lg bg-gradient-to-br ${emp.color} px-3 py-2 text-left transition-all ${executorId === emp.id ? 'ring-2 ring-white/40 shadow-lg' : 'opacity-50 hover:opacity-80'}`}>
                    <p className="text-xs font-semibold text-white">{emp.name}</p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                {teams.length === 0 ? <p className="text-[11px] text-zinc-600">No teams created yet.</p> : teams.map((team) => (
                  <button key={team.id} onClick={() => setExecutorId(team.id)} className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all ${executorId === team.id ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 hover:border-white/20'}`}>
                    <span className={`text-xs font-medium ${executorId === team.id ? 'text-emerald-300' : 'text-zinc-400'}`}>{team.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Model</p>
            <div className="flex gap-2">
              {[{ id: 'haiku', label: 'Haiku', desc: 'Fast' }, { id: 'sonnet', label: 'Sonnet', desc: 'Recommended' }, { id: 'opus', label: 'Opus', desc: 'Most capable' }].map((m) => (
                <button key={m.id} onClick={() => setModel(m.id)} className={`flex-1 rounded-lg border px-3 py-2 text-left transition-all ${model === m.id ? 'border-emerald-500/50 bg-emerald-500/10' : 'border-white/10 hover:border-white/20'}`}>
                  <p className={`text-xs font-medium ${model === m.id ? 'text-emerald-300' : 'text-zinc-400'}`}>{m.label}</p>
                  <p className={`text-[10px] ${m.id === 'sonnet' ? 'text-emerald-400/60' : 'text-zinc-600'}`}>{m.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Schedule</p>
            <div className="flex gap-2 mb-2">
              {(['anytime', 'fixed', 'recurring'] as const).map((s) => (
                <button key={s} onClick={() => setScheduleType(s)} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${scheduleType === s ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>
                  {s === 'anytime' ? 'Anytime' : s === 'fixed' ? 'Fixed Date' : 'Recurring'}
                </button>
              ))}
            </div>

            {scheduleType === 'fixed' && (
              <SchedulePicker month={month} setMonth={setMonth} day={day} setDay={setDay} year={year} setYear={setYear} hour={hour} setHour={setHour} minute={minute} setMinute={setMinute} period={period} setPeriod={setPeriod} accentColor="emerald" />
            )}

            {scheduleType === 'recurring' && (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
                <p className="text-[11px] text-emerald-300 mb-2">Run every:</p>
                <div className="flex items-center gap-2">
                  <input type="number" min="1" max="365" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} className="w-16 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center text-sm text-zinc-200 focus:border-emerald-500/50 focus:outline-none" />
                  <span className="text-xs text-zinc-400">days</span>
                  <span className="text-[10px] text-zinc-600">(14 days recommended)</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-emerald-500/20 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <button onClick={handleSubmit} disabled={!canSubmit || submitting} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-30">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
            </svg>
            {submitting ? 'Creating...' : scanType === 'full' ? 'Start Full Analysis' : 'Start Targeted Analysis'}
          </button>
          <button onClick={onClose} className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Security Scan Modal ────────────────────────────────────────────────────

function SecurityScanModal({
  projectId,
  teams,
  onCreated,
  onClose,
}: {
  projectId: string
  teams: TeamOption[]
  onCreated: (task: TaskItem) => void
  onClose: () => void
}) {
  const [scanType, setScanType] = useState<'full' | 'targeted'>('full')
  const [instruction, setInstruction] = useState('')
  const [taskIntent, setTaskIntent] = useState<'analyze_fix' | 'conversation'>('conversation')
  const [executorType, setExecutorType] = useState<'skill' | 'team'>('skill')
  const [executorId, setExecutorId] = useState('security')
  const [model, setModel] = useState('opus')
  const [scheduleType, setScheduleType] = useState<'anytime' | 'fixed' | 'recurring'>('anytime')
  const [intervalDays, setIntervalDays] = useState('7')
  const [hoveredInfo, setHoveredInfo] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Schedule state
  const now = new Date()
  const [month, setMonth] = useState(String(now.getMonth()))
  const [day, setDay] = useState('')
  const [year, setYear] = useState(String(now.getFullYear()))
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('00')
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM')
  const SEC_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  function getScheduledAt(): string | null {
    if (scheduleType !== 'fixed') return null
    if (!month || !day || !year) return null
    const h24 = period === 'AM' ? (hour === '12' ? 0 : parseInt(hour)) : (hour === '12' ? 12 : parseInt(hour) + 12)
    return `${year}-${String(parseInt(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${String(h24).padStart(2, '0')}:${minute}:00.000Z`
  }

  async function handleSubmit() {
    if (submitting) return
    if (scanType === 'targeted' && !instruction.trim()) return
    setSubmitting(true)

    const taskName = scanType === 'full'
      ? 'Security Scan — Full Repository Audit'
      : `Security Scan — ${instruction.trim().slice(0, 60)}`

    const securityInstruction = scanType === 'full'
      ? 'Perform a comprehensive security audit of the entire repository. Follow the full enterprise security context provided.'
      : instruction.trim()

    try {
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: taskName,
          instruction: securityInstruction,
          executorType,
          executorId,
          status: 'queue',
          scheduledAt: getScheduledAt(),
          isRecurring: scheduleType === 'recurring',
          recurrenceConfig: scheduleType === 'recurring' ? { intervalDays: parseInt(intervalDays) || 7 } : undefined,
          accumulatedContext: { model, intent: taskIntent },
          context: {
            source: 'security_scan',
            scanType,
            securityContext: scanType === 'full' ? 'full_scan' : 'targeted',
          },
        }),
      })
      if (res.ok) {
        const created = await res.json()
        onCreated(created)
      }
    } catch {}
    setSubmitting(false)
  }

  const INTENT_OPTIONS: { id: 'analyze_fix' | 'conversation'; label: string; desc: string; color: string }[] = [
    { id: 'conversation', label: 'Analyze Only', desc: 'Review and report — no code changes', color: 'text-sky-300' },
    { id: 'analyze_fix', label: 'Analyze & Fix', desc: 'Find issues and fix them if possible', color: 'text-amber-300' },
  ]

  const canSubmit = (scanType === 'full' || instruction.trim()) && executorId

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-red-500/20 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-red-500/20 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20">
              <svg className="h-4 w-4 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">Security Scan</h2>
              <p className="text-[11px] text-zinc-500">Enterprise-level security audit</p>
            </div>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Scrollable form */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Scan type toggle */}
          <div>
            <div className="flex gap-2">
              <button
                onClick={() => setScanType('full')}
                className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-all ${
                  scanType === 'full' ? 'border-red-500/50 bg-red-500/10' : 'border-white/10 hover:border-white/20'
                }`}
              >
                <p className={`text-xs font-medium ${scanType === 'full' ? 'text-red-300' : 'text-zinc-400'}`}>Full Scan</p>
                <p className="text-[10px] text-zinc-600">Entire repository audit</p>
              </button>
              <button
                onClick={() => setScanType('targeted')}
                className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-all ${
                  scanType === 'targeted' ? 'border-amber-500/50 bg-amber-500/10' : 'border-white/10 hover:border-white/20'
                }`}
              >
                <p className={`text-xs font-medium ${scanType === 'targeted' ? 'text-amber-300' : 'text-zinc-400'}`}>Targeted</p>
                <p className="text-[10px] text-zinc-600">Focus on specific area</p>
              </button>
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">
              {scanType === 'full'
                ? 'Will use the full enterprise security context (OWASP Top 10, STRIDE, CWE, SANS Top 25) and scan the entire repository.'
                : 'Will use the full enterprise security context but focused on the area you specify below.'}
            </p>
          </div>

          {/* Security context (locked, read-only) */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Security Context</p>
            <div className="flex items-center gap-3 rounded-lg border border-red-500/15 bg-red-500/[0.04] p-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/15">
                <svg className="h-4 w-4 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
                </svg>
              </div>
              <div>
                <p className="text-[11px] font-medium text-red-300">Enterprise Security Audit Context</p>
                <p className="text-[9px] text-zinc-500">OWASP Top 10 · STRIDE · CWE · SANS Top 25 · Secret Detection · Dependency Audit</p>
              </div>
            </div>
          </div>

          {/* Instruction (disabled for full, enabled for targeted) */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Instructions</p>
            {scanType === 'full' ? (
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <p className="text-[11px] text-zinc-600 italic">Full repository security review — comprehensive scan using all security frameworks</p>
              </div>
            ) : (
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="What should be audited? e.g. 'Review the authentication flow', 'Audit the payment endpoints', 'Check the file upload feature'..."
                rows={3}
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-amber-500/50 focus:outline-none"
              />
            )}
          </div>

          {/* Intent (only analyze or analyze+fix, no build) */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">What should happen</p>
            <div className="space-y-1.5">
              {INTENT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setTaskIntent(opt.id)}
                  className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all ${
                    taskIntent === opt.id ? 'border-red-500/40 bg-red-500/[0.06]' : 'border-white/10 hover:border-white/20'
                  }`}
                >
                  <div className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                    taskIntent === opt.id ? 'border-red-500 bg-red-500' : 'border-zinc-600'
                  }`}>
                    {taskIntent === opt.id && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </div>
                  <div>
                    <p className={`text-xs font-medium ${taskIntent === opt.id ? opt.color : 'text-zinc-400'}`}>{opt.label}</p>
                    <p className="text-[10px] text-zinc-600">{opt.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Builder warning */}
          <BuilderWarning intent={taskIntent} executorType={executorType} executorId={executorId} teams={teams} />

          {/* Executor */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Assign to</p>
            <div className="flex gap-2 mb-2">
              <button onClick={() => { setExecutorType('skill'); setExecutorId('security') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${executorType === 'skill' ? 'border-red-500/50 bg-red-500/10 text-red-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Employee</button>
              <button onClick={() => { setExecutorType('team'); setExecutorId('') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${executorType === 'team' ? 'border-red-500/50 bg-red-500/10 text-red-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Team</button>
            </div>
            {executorType === 'skill' ? (
              <div className="grid grid-cols-2 gap-1.5">
                {EMPLOYEES.map((emp) => (
                  <button key={emp.id} onClick={() => setExecutorId(emp.id)} className={`rounded-lg bg-gradient-to-br ${emp.color} px-3 py-2 text-left transition-all ${executorId === emp.id ? 'ring-2 ring-white/40 shadow-lg' : 'opacity-50 hover:opacity-80'}`}>
                    <p className="text-xs font-semibold text-white">{emp.name}</p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                {teams.length === 0 ? <p className="text-[11px] text-zinc-600">No teams created yet.</p> : teams.map((team) => (
                  <button key={team.id} onClick={() => setExecutorId(team.id)} className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all ${executorId === team.id ? 'border-red-500/50 bg-red-500/10' : 'border-white/10 hover:border-white/20'}`}>
                    <span className={`text-xs font-medium ${executorId === team.id ? 'text-red-300' : 'text-zinc-400'}`}>{team.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Model</p>
            <div className="flex gap-2">
              {[{ id: 'haiku', label: 'Haiku', desc: 'Fast' }, { id: 'sonnet', label: 'Sonnet', desc: 'Balanced' }, { id: 'opus', label: 'Opus', desc: 'Recommended' }].map((m) => (
                <button key={m.id} onClick={() => setModel(m.id)} className={`flex-1 rounded-lg border px-3 py-2 text-left transition-all ${model === m.id ? 'border-red-500/50 bg-red-500/10' : 'border-white/10 hover:border-white/20'}`}>
                  <p className={`text-xs font-medium ${model === m.id ? 'text-red-300' : 'text-zinc-400'}`}>{m.label}</p>
                  <p className={`text-[10px] ${m.id === 'opus' ? 'text-red-400/60' : 'text-zinc-600'}`}>{m.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Schedule</p>
            <div className="flex gap-2 mb-2">
              {(['anytime', 'fixed', 'recurring'] as const).map((s) => (
                <button key={s} onClick={() => setScheduleType(s)} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${scheduleType === s ? 'border-red-500/50 bg-red-500/10 text-red-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>
                  {s === 'anytime' ? 'Anytime' : s === 'fixed' ? 'Fixed Date' : 'Recurring'}
                </button>
              ))}
            </div>

            {scheduleType === 'fixed' && (
              <SchedulePicker month={month} setMonth={setMonth} day={day} setDay={setDay} year={year} setYear={setYear} hour={hour} setHour={setHour} minute={minute} setMinute={setMinute} period={period} setPeriod={setPeriod} accentColor="red" />
            )}

            {scheduleType === 'recurring' && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/[0.04] p-3">
                <p className="text-[11px] text-red-300 mb-2">Run every:</p>
                <div className="flex items-center gap-2">
                  <input type="number" min="1" max="365" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} className="w-16 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center text-sm text-zinc-200 focus:border-red-500/50 focus:outline-none" />
                  <span className="text-xs text-zinc-400">days</span>
                  <span className="text-[10px] text-zinc-600">(7 days recommended)</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-red-500/20 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <button onClick={handleSubmit} disabled={!canSubmit || submitting} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-red-600 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-30">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
            {submitting ? 'Creating...' : scanType === 'full' ? 'Start Full Scan' : 'Start Targeted Scan'}
          </button>
          <button onClick={onClose} className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Create Task Modal ──────────────────────────────────────────────────────

function CreateTaskModal({
  projectId,
  teams,
  onCreated,
  onClose,
}: {
  projectId: string
  teams: TeamOption[]
  onCreated: (task: TaskItem) => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [instruction, setInstruction] = useState('')
  const [uploadedFile, setUploadedFile] = useState<{ name: string; content: string } | null>(null)
  const [taskIntent, setTaskIntent] = useState<'build' | 'analyze_fix' | 'conversation'>('build')
  const [hoveredInfo, setHoveredInfo] = useState<string | null>(null)
  const [executorType, setExecutorType] = useState<'skill' | 'team'>('skill')
  const [executorId, setExecutorId] = useState('')
  const [model, setModel] = useState('sonnet')
  const [permissionMode, setPermissionMode] = useState<'leitura' | 'planejamento' | 'edicao'>('edicao')
  const [scheduleType, setScheduleType] = useState<'anytime' | 'fixed' | 'recurring'>('anytime')
  const [intervalDays, setIntervalDays] = useState('7')
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Schedule state (reuse from ScheduleModal)
  const now = new Date()
  const [month, setMonth] = useState(String(now.getMonth()))
  const [day, setDay] = useState('')
  const [year, setYear] = useState(String(now.getFullYear()))
  const [hour, setHour] = useState('9')
  const [minute, setMinute] = useState('00')
  const [period, setPeriod] = useState<'AM' | 'PM'>('AM')
  const MONTHS_LIST = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  function getScheduledAt(): string | null {
    if (scheduleType !== 'fixed') return null
    if (!month || !day || !year) return null
    const h24 = period === 'AM' ? (hour === '12' ? 0 : parseInt(hour)) : (hour === '12' ? 12 : parseInt(hour) + 12)
    return `${year}-${String(parseInt(month) + 1).padStart(2, '0')}-${day.padStart(2, '0')}T${String(h24).padStart(2, '0')}:${minute}:00.000Z`
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setUploadedFile({ name: file.name, content: text.slice(0, 50000) })
  }

  async function handleSubmit() {
    if (!name.trim() || !executorId || submitting) return
    setSubmitting(true)
    try {
      const taskData: Record<string, unknown> = {
        name: name.trim(),
        instruction: instruction.trim() || null,
        executorType,
        executorId,
        status: 'queue',
        scheduledAt: getScheduledAt(),
        isRecurring: scheduleType === 'recurring',
        recurrenceConfig: scheduleType === 'recurring' ? { intervalDays: parseInt(intervalDays) || 7 } : undefined,
        permissionMode,
        accumulatedContext: { model, intent: taskIntent },
        context: {
          source: 'manual',
          ...(uploadedFile ? { uploadedFile: { name: uploadedFile.name, content: uploadedFile.content } } : {}),
        },
      }
      const res = await fetch(`/api/projects/${projectId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskData),
      })
      if (res.ok) {
        const created = await res.json()
        onCreated(created)
      }
    } catch {}
    setSubmitting(false)
  }

  const canSubmit = name.trim() && executorId && (scheduleType !== 'fixed' || (month && day && year))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Create Task</h2>
            <p className="text-[11px] text-zinc-500">Goes directly to the queue — fully configured.</p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Scrollable form */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Name */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Task Name</p>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="What needs to be done?" className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-violet-500/50 focus:outline-none" />
          </div>

          {/* Instruction */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Instructions</p>
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Detailed instructions for the executor..." rows={3} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-violet-500/50 focus:outline-none" />
          </div>

          {/* Upload context */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Context File (optional)</p>
            {uploadedFile ? (
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
                <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                <span className="flex-1 text-xs text-zinc-300 truncate">{uploadedFile.name}</span>
                <button onClick={() => setUploadedFile(null)} className="text-zinc-500 hover:text-red-400">
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            ) : (
              <button onClick={() => fileInputRef.current?.click()} className="flex w-full items-center gap-2 rounded-lg border border-dashed border-white/15 bg-white/[0.02] px-3 py-3 text-xs text-zinc-500 hover:border-white/25 hover:bg-white/[0.04]">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" /></svg>
                Upload PDF, text, code, or docs
              </button>
            )}
            <input ref={fileInputRef} type="file" accept=".pdf,.txt,.md,.ts,.tsx,.js,.jsx,.json,.py,.go,.rs,.css,.html" className="hidden" onChange={handleUpload} />
          </div>

          {/* Intent */}
          <TaskIntentSelector value={taskIntent} onChange={setTaskIntent} hoveredInfo={hoveredInfo} onHoverInfo={setHoveredInfo} />

          {/* Builder warning */}
          <BuilderWarning intent={taskIntent} executorType={executorType} executorId={executorId} teams={teams} />

          {/* Executor */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Assign to</p>
            <div className="flex gap-2 mb-2">
              <button onClick={() => { setExecutorType('skill'); setExecutorId('') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${executorType === 'skill' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Employee</button>
              <button onClick={() => { setExecutorType('team'); setExecutorId('') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${executorType === 'team' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Team</button>
            </div>
            {executorType === 'skill' ? (
              <div className="grid grid-cols-2 gap-1.5">
                {EMPLOYEES.map((emp) => (
                  <button key={emp.id} onClick={() => setExecutorId(emp.id)} className={`rounded-lg bg-gradient-to-br ${emp.color} px-3 py-2 text-left transition-all ${executorId === emp.id ? 'ring-2 ring-white/40 shadow-lg' : 'opacity-50 hover:opacity-80'}`}>
                    <p className="text-xs font-semibold text-white">{emp.name}</p>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-1.5">
                {teams.length === 0 ? <p className="text-[11px] text-zinc-600">No teams created yet.</p> : teams.map((team) => (
                  <button key={team.id} onClick={() => setExecutorId(team.id)} className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all ${executorId === team.id ? 'border-violet-500/50 bg-violet-500/10' : 'border-white/10 hover:border-white/20'}`}>
                    <span className={`text-xs font-medium ${executorId === team.id ? 'text-violet-300' : 'text-zinc-400'}`}>{team.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Model */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Model</p>
            <div className="flex gap-2">
              {[{ id: 'haiku', label: 'Haiku', desc: 'Fast, cheap' }, { id: 'sonnet', label: 'Sonnet', desc: 'Balanced' }, { id: 'opus', label: 'Opus', desc: 'Most capable' }].map((m) => (
                <button key={m.id} onClick={() => setModel(m.id)} className={`flex-1 rounded-lg border px-3 py-2 text-left transition-all ${model === m.id ? 'border-violet-500/50 bg-violet-500/10' : 'border-white/10 hover:border-white/20'}`}>
                  <p className={`text-xs font-medium ${model === m.id ? 'text-violet-300' : 'text-zinc-400'}`}>{m.label}</p>
                  <p className="text-[10px] text-zinc-600">{m.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Permission Mode */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Mode</p>
            <div className="flex gap-2">
              {([
                { id: 'leitura', label: 'Ask', desc: 'Read and analyze only' },
                { id: 'planejamento', label: 'Plan', desc: 'Plan without executing' },
                { id: 'edicao', label: 'Agent', desc: 'Full access' },
              ] as const).map((m) => (
                <button key={m.id} onClick={() => setPermissionMode(m.id)} className={`flex-1 rounded-lg border px-3 py-2 text-left transition-all ${permissionMode === m.id ? 'border-violet-500/50 bg-violet-500/10' : 'border-white/10 hover:border-white/20'}`}>
                  <p className={`text-xs font-medium ${permissionMode === m.id ? 'text-violet-300' : 'text-zinc-400'}`}>{m.label}</p>
                  <p className="text-[10px] text-zinc-600">{m.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Schedule */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Schedule</p>
            <div className="flex gap-2 mb-2">
              {(['anytime', 'fixed', 'recurring'] as const).map((s) => (
                <button key={s} onClick={() => setScheduleType(s)} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${scheduleType === s ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>
                  {s === 'anytime' ? 'Anytime' : s === 'fixed' ? 'Fixed Date' : 'Recurring'}
                </button>
              ))}
            </div>

            {scheduleType === 'fixed' && (
              <SchedulePicker month={month} setMonth={setMonth} day={day} setDay={setDay} year={year} setYear={setYear} hour={hour} setHour={setHour} minute={minute} setMinute={setMinute} period={period} setPeriod={setPeriod} accentColor="violet" />
            )}

            {scheduleType === 'recurring' && (
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
                <p className="text-[11px] text-cyan-300 mb-2">Run every:</p>
                <div className="flex items-center gap-2">
                  <input type="number" min="1" max="365" value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)} className="w-16 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center text-sm text-zinc-200 focus:border-cyan-500/50 focus:outline-none" />
                  <span className="text-xs text-zinc-400">days</span>
                </div>
                <p className="mt-2 text-[10px] text-zinc-500">First run enters queue immediately. Next runs auto-schedule after each completion.</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <button onClick={handleSubmit} disabled={!canSubmit || submitting} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-violet-600 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30">
            {submitting ? 'Creating...' : scheduleType === 'recurring' ? 'Create Recurring Task' : 'Send to Queue'}
          </button>
          <button onClick={onClose} className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Manage Recurring Modal ────────────────────────────────────────────────

function ManageRecurringModal({
  projectId,
  tasks,
  teams,
  onUpdated,
  onDeleted,
  onClose,
}: {
  projectId: string
  tasks: TaskItem[]
  teams: TeamOption[]
  onUpdated: (task: TaskItem) => void
  onDeleted: (id: string) => void
  onClose: () => void
}) {
  async function handleDelete(taskId: string) {
    try {
      // Delete the task + all future recurrences
      await fetch(`/api/projects/${projectId}/tasks/${taskId}`, { method: 'DELETE' })
      onDeleted(taskId)
    } catch {}
  }

  async function handleSkip(task: TaskItem) {
    const interval = (task.recurrenceConfig as { intervalDays?: number })?.intervalDays ?? 7
    const currentScheduled = task.scheduledAt ? new Date(task.scheduledAt) : new Date()
    const newScheduled = new Date(currentScheduled.getTime() + interval * 24 * 60 * 60 * 1000)

    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: newScheduled.toISOString() }),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch {}
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Recurring Tasks</h2>
            <p className="text-[11px] text-zinc-500">{tasks.length} active recurring task{tasks.length !== 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-2">
          {tasks.length === 0 && (
            <div className="py-8 text-center">
              <p className="text-xs text-zinc-500">No recurring tasks</p>
              <p className="text-[10px] text-zinc-600 mt-1">Create one with the "Create Task" button and select "Recurring"</p>
            </div>
          )}

          {tasks.map((task) => {
            const interval = (task.recurrenceConfig as { intervalDays?: number })?.intervalDays ?? 7
            const executorName = getExecutorName(task, teams)
            const intent = INTENT_LABELS[task.accumulatedContext?.intent ?? '']

            return (
              <div key={task.id} className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-4">
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-zinc-200">{task.name}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] text-zinc-500">{executorName}</span>
                      {intent && <span className={`text-[9px] font-medium ${intent.color}`}>{intent.label}</span>}
                      <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-medium text-cyan-400">every {interval} days</span>
                      <span className="text-[10px] text-zinc-600">{task.accumulatedContext?.model ?? 'sonnet'}</span>
                    </div>
                    {task.scheduledAt && (
                      <p className="mt-1 text-[10px] text-zinc-500">
                        Next: {new Date(task.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 ml-2">
                    <button
                      onClick={() => handleSkip(task)}
                      title="Skip next run"
                      className="flex h-7 items-center gap-1 rounded-lg border border-white/10 px-2 text-[10px] text-zinc-400 hover:bg-white/5 hover:text-zinc-300"
                    >
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69zM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z" /></svg>
                      Skip
                    </button>
                    <button
                      onClick={() => handleDelete(task.id)}
                      title="Stop recurring"
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-red-500/10 hover:text-red-400"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" /></svg>
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Reorder Modal ──────────────────────────────────────────────────────────

function ReorderModal({
  tasks,
  projectId,
  teams,
  onSave,
  onClose,
}: {
  tasks: TaskItem[]
  projectId: string
  teams: TeamOption[]
  onSave: (ids: string[]) => void
  onClose: () => void
}) {
  const [order, setOrder] = useState(tasks.map((t) => t.id))
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const taskMap = new Map(tasks.map((t) => [t.id, t]))

  function handleDragStart(i: number) { setDragIdx(i) }
  function handleDragOver(e: React.DragEvent, i: number) {
    e.preventDefault()
    if (dragIdx === null || dragIdx === i) return
    const newOrder = [...order]
    const [dragged] = newOrder.splice(dragIdx, 1)
    newOrder.splice(i, 0, dragged)
    setOrder(newOrder)
    setDragIdx(i)
  }
  function handleDragEnd() { setDragIdx(null) }

  async function handleSave() {
    setSaving(true)
    try {
      await fetch(`/api/projects/${projectId}/tasks/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskIds: order }),
      })
      onSave(order)
    } catch {}
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 shadow-2xl"
        style={{ backgroundColor: '#1a1a22' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Reorder Queue Priority</h2>
            <p className="text-[11px] text-zinc-500">Drag tasks to set execution order. Top = runs first.</p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-1.5">
          {order.map((id, i) => {
            const task = taskMap.get(id)
            if (!task) return null
            const executor = getExecutorName(task, teams)
            const intent = INTENT_LABELS[task.accumulatedContext?.intent ?? '']

            return (
              <div
                key={id}
                draggable
                onDragStart={() => handleDragStart(i)}
                onDragOver={(e) => handleDragOver(e, i)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] p-3 cursor-grab active:cursor-grabbing transition-all ${
                  dragIdx === i ? 'scale-[1.02] shadow-lg shadow-violet-500/10 border-violet-500/40' : ''
                }`}
              >
                {/* Drag handle + position */}
                <div className="flex flex-col items-center gap-0.5 shrink-0">
                  <svg className="h-3.5 w-3.5 text-zinc-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9h16.5m-16.5 6.75h16.5" />
                  </svg>
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-500/20 text-[10px] font-bold text-violet-300">{i + 1}</span>
                </div>

                {/* Task info */}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-zinc-200 truncate">{task.name}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-zinc-500">{executor}</span>
                    {intent && <span className={`text-[9px] font-medium ${intent.color}`}>{intent.label}</span>}
                  </div>
                </div>
              </div>
            )
          })}

          {order.length === 0 && (
            <p className="py-4 text-center text-[11px] text-zinc-600">No anytime tasks to reorder</p>
          )}
        </div>

        <div className="flex gap-3 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex h-9 flex-1 items-center justify-center rounded-lg bg-violet-600 text-xs font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-30"
          >
            {saving ? 'Saving...' : 'Save Order'}
          </button>
          <button
            onClick={onClose}
            className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Queue Card ─────────────────────────────────────────────────────────────

const INTENT_LABELS: Record<string, { label: string; color: string }> = {
  build: { label: 'Build', color: 'text-emerald-400' },
  analyze_fix: { label: 'Analyze & Fix', color: 'text-amber-400' },
  conversation: { label: 'Review & Discuss', color: 'text-sky-400' },
}

function getExecutorName(task: TaskItem, teams: TeamOption[]): string {
  if (task.executorType === 'team') {
    return teams.find((t) => t.id === task.executorId)?.name ?? 'Team'
  }
  return EMPLOYEES.find((e) => e.id === task.executorId)?.name ?? 'Unassigned'
}

function QueueCard({ task, teams, onClick }: { task: TaskItem; teams: TeamOption[]; onClick: () => void }) {
  const timeAgo = getTimeAgo(task.createdAt)
  const intent = INTENT_LABELS[task.accumulatedContext?.intent ?? '']
  const executorName = getExecutorName(task, teams)
  const model = task.accumulatedContext?.model ?? 'sonnet'

  return (
    <button
      onClick={onClick}
      className={`w-full shrink-0 rounded-lg border ${STATUS_CARD_STYLES.queue.border} ${STATUS_CARD_STYLES.queue.bg} p-3 text-left transition-all ${STATUS_CARD_STYLES.queue.hover}`}
    >
      <p className="text-xs font-medium text-violet-200 line-clamp-2">{task.name}</p>
      <div className="mt-2 flex items-center gap-2">
        {/* Executor */}
        <div className="flex items-center gap-1">
          <svg className="h-3 w-3 text-zinc-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
          </svg>
          <span className="text-[10px] font-medium text-zinc-300">{executorName}</span>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {/* Intent */}
        {intent && (
          <span className={`rounded bg-white/5 px-1.5 py-0.5 text-[9px] font-medium ${intent.color}`}>{intent.label}</span>
        )}
        {/* Schedule */}
        {task.scheduledAt ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
            {new Date(task.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            {' '}
            {new Date(task.scheduledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </span>
        ) : (
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-medium text-violet-400">anytime</span>
        )}
        {/* Model */}
        <span className="rounded bg-white/5 px-1.5 py-0.5 text-[9px] text-zinc-500">{model}</span>
        {/* Time */}
        <span className="text-[10px] text-zinc-600">{timeAgo}</span>
        {/* Badges */}
        {task.isRecurring && (
          <span className="rounded bg-cyan-500/15 px-1.5 py-0.5 text-[9px] font-medium text-cyan-400">recurring</span>
        )}
        {task.context?.source === 'manual' && !task.isRecurring && (
          <span className="rounded bg-zinc-500/15 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">manual</span>
        )}
        {task.context?.source === 'security_scan' && (
          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-400">security</span>
        )}
        {task.context?.source === 'code_health' && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-medium text-emerald-400">health</span>
        )}
        {task.rescheduledCount > 0 && (
          <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-medium text-red-400">rescheduled</span>
        )}
      </div>
      {/* Reschedule warning */}
      {task.rescheduledReason && (
        <div className="mt-1.5 flex items-center gap-1 text-[9px] text-amber-400/80">
          <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
          <span>{task.rescheduledReason} ({task.rescheduledCount}x)</span>
        </div>
      )}
      {/* Fail reason */}
      {task.accumulatedContext?.failReason && (
        <div className="mt-1.5 flex items-center gap-1 text-[9px] text-red-400/80">
          <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span>{task.accumulatedContext.failReason}</span>
        </div>
      )}
    </button>
  )
}

// ── Queue Detail Modal ─────────────────────────────────────────────────────

function QueueDetailModal({
  task,
  projectId,
  teams,
  onClose,
  onUpdated,
  onDeleted,
}: {
  task: TaskItem
  projectId: string
  teams: TeamOption[]
  onClose: () => void
  onUpdated: (t: TaskItem) => void
  onDeleted: (id: string) => void
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [showReportModal, setShowReportModal] = useState(false)
  const [showContextModal, setShowContextModal] = useState(false)

  // Edit state
  const [editInstruction, setEditInstruction] = useState(task.instruction ?? '')
  const [editIntent, setEditIntent] = useState<'build' | 'analyze_fix' | 'conversation'>(task.accumulatedContext?.intent ?? 'build')
  const [editHoveredInfo, setEditHoveredInfo] = useState<string | null>(null)
  const [editExecutorType, setEditExecutorType] = useState<'skill' | 'team'>(task.executorType === 'team' ? 'team' : 'skill')
  const [editExecutorId, setEditExecutorId] = useState(task.executorId ?? '')
  const [editModel, setEditModel] = useState(task.accumulatedContext?.model ?? 'sonnet')
  const [editScheduleType, setEditScheduleType] = useState<'anytime' | 'fixed'>(task.scheduledAt ? 'fixed' : 'anytime')

  // Parse existing scheduled date for edit
  const existingDate = task.scheduledAt ? new Date(task.scheduledAt) : null
  const editNow = new Date()
  const [editMonth, setEditMonth] = useState(String(existingDate ? existingDate.getMonth() : editNow.getMonth()))
  const [editDay, setEditDay] = useState(existingDate ? String(existingDate.getDate()).padStart(2, '0') : '')
  const [editYear, setEditYear] = useState(String(existingDate ? existingDate.getFullYear() : editNow.getFullYear()))
  const [editHour, setEditHour] = useState(existingDate ? String(existingDate.getHours() % 12 || 12) : '9')
  const [editMinute, setEditMinute] = useState(existingDate ? String(existingDate.getMinutes()).padStart(2, '0') : '00')
  const [editPeriod, setEditPeriod] = useState<'AM' | 'PM'>(existingDate ? (existingDate.getHours() >= 12 ? 'PM' : 'AM') : 'AM')

  const [submitting, setSubmitting] = useState(false)

  const EDIT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const editIsDateComplete = editMonth !== '' && editDay !== '' && editYear !== ''

  // Smart date validation
  const eNowYear = editNow.getFullYear()
  const eNowMonth = editNow.getMonth()
  const eNowDay = editNow.getDate()
  const eNowHour = editNow.getHours()
  const eSelYear = parseInt(editYear)
  const eSelMonth = parseInt(editMonth)
  const eSelDay = parseInt(editDay)
  const eIsToday = eSelYear === eNowYear && eSelMonth === eNowMonth && eSelDay === eNowDay

  function eIsMonthDisabled(m: number) { return eSelYear === eNowYear && m < eNowMonth }
  function eIsDayDisabled(d: number) {
    if (eSelYear > eNowYear) return false
    if (eSelYear === eNowYear && eSelMonth > eNowMonth) return false
    if (eSelYear === eNowYear && eSelMonth === eNowMonth) return d < eNowDay
    return true
  }
  function eIsHourDisabled(h12: number, p: 'AM' | 'PM') {
    if (!eIsToday) return false
    const h24 = p === 'AM' ? (h12 === 12 ? 0 : h12) : (h12 === 12 ? 12 : h12 + 12)
    return h24 < eNowHour
  }

  function getEditScheduledAt(): string | null {
    if (editScheduleType !== 'fixed' || !editIsDateComplete) return null
    const h24 = editPeriod === 'AM' ? (editHour === '12' ? 0 : parseInt(editHour)) : (editHour === '12' ? 12 : parseInt(editHour) + 12)
    return `${editYear}-${String(parseInt(editMonth) + 1).padStart(2, '0')}-${editDay.padStart(2, '0')}T${String(h24).padStart(2, '0')}:${editMinute}:00.000Z`
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const report = task.context?.report as any
  const conversationSummary = task.context?.conversationSummary
  const intent = INTENT_LABELS[task.accumulatedContext?.intent ?? '']
  const executorName = getExecutorName(task, teams)

  async function handleSaveEdit() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: editInstruction.trim() || null,
          executorType: editExecutorType,
          executorId: editExecutorId || null,
          scheduledAt: getEditScheduledAt(),
          accumulatedContext: { model: editModel, intent: editIntent },
        }),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  async function handleDelete() {
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, { method: 'DELETE' })
      if (res.ok || res.status === 204) onDeleted(task.id)
    } catch { /* ignore */ }
  }

  async function handleBackToPending() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'pending',
          instruction: null,
          executorType: 'no_skill',
          executorId: null,
          scheduledAt: null,
          accumulatedContext: {},
        }),
      })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  async function handleRunTask() {
    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}/run`, { method: 'POST' })
      if (res.ok) {
        const updated = await res.json()
        onUpdated(updated)
      }
    } catch { /* ignore */ }
    setSubmitting(false)
  }

  // Delete confirmation
  if (mode === 'delete') {
    const isRecurringTask = task.isRecurring
    const intervalDays = (task.recurrenceConfig as { intervalDays?: number })?.intervalDays ?? 7

    async function handleSkipRecurring() {
      const current = task.scheduledAt ? new Date(task.scheduledAt) : new Date()
      const next = new Date(current.getTime() + intervalDays * 24 * 60 * 60 * 1000)
      try {
        const res = await fetch(`/api/projects/${projectId}/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scheduledAt: next.toISOString() }),
        })
        if (res.ok) { const updated = await res.json(); onUpdated(updated) }
      } catch {}
    }

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
        <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
          <div className="border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
            <h2 className="text-sm font-semibold text-zinc-100">{isRecurringTask ? 'Recurring Task' : 'Remove Task'}</h2>
          </div>
          <div className="p-6 space-y-3">
            {isRecurringTask ? (
              <>
                <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.04] p-3">
                  <p className="text-[11px] text-cyan-300">This is a recurring task. It cannot be deleted from here — manage it in the Recurring Tasks panel.</p>
                </div>
                <button
                  onClick={handleSkipRecurring}
                  className="flex w-full h-10 items-center justify-center gap-2 rounded-lg border border-cyan-500/30 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-500/10"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061A1.125 1.125 0 013 16.811V8.69zM12.75 8.689c0-.864.933-1.406 1.683-.977l7.108 4.061a1.125 1.125 0 010 1.954l-7.108 4.061a1.125 1.125 0 01-1.683-.977V8.69z" />
                  </svg>
                  Skip this run (+{intervalDays} days)
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-zinc-400">What would you like to do with this task?</p>
                <button
                  onClick={handleDelete}
                  className="flex w-full h-10 items-center justify-center gap-2 rounded-lg bg-red-600 text-xs font-medium text-white transition-colors hover:bg-red-500"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                  Delete permanently
                </button>
                <button
                  onClick={handleBackToPending}
                  disabled={submitting}
                  className="flex w-full h-10 items-center justify-center gap-2 rounded-lg border border-white/10 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
                  </svg>
                  {submitting ? 'Moving...' : 'Back to Pending'}
                </button>
              </>
            )}
            <button onClick={() => setMode('view')} className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300">Cancel</button>
          </div>
        </div>
      </div>
    )
  }

  // Edit mode
  if (mode === 'edit') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
        <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
            <h2 className="text-sm font-semibold text-zinc-100">Edit Task</h2>
            <button onClick={() => setMode('view')} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="max-h-[70vh] overflow-y-auto p-6 space-y-4">
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">What should be done</p>
              <textarea value={editInstruction} onChange={(e) => setEditInstruction(e.target.value)} rows={3} className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-violet-500/50 focus:outline-none" />
            </div>
            <TaskIntentSelector value={editIntent} onChange={setEditIntent} hoveredInfo={editHoveredInfo} onHoverInfo={setEditHoveredInfo} />
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Assign to</p>
              <div className="flex gap-2 mb-2">
                <button onClick={() => { setEditExecutorType('skill'); setEditExecutorId('') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${editExecutorType === 'skill' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Employee</button>
                <button onClick={() => { setEditExecutorType('team'); setEditExecutorId('') }} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${editExecutorType === 'team' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Team</button>
              </div>
              {editExecutorType === 'skill' ? (
                <div className="grid grid-cols-2 gap-1.5">
                  {EMPLOYEES.map((emp) => (
                    <button key={emp.id} onClick={() => setEditExecutorId(emp.id)} className={`rounded-lg bg-gradient-to-br ${emp.color} px-3 py-2 text-left transition-all ${editExecutorId === emp.id ? 'ring-2 ring-white/40 shadow-lg' : 'opacity-50 hover:opacity-80'}`}>
                      <p className="text-xs font-semibold text-white">{emp.name}</p>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {teams.length === 0 ? <p className="text-[11px] text-zinc-600">No teams created yet.</p> : teams.map((team) => (
                    <button key={team.id} onClick={() => setEditExecutorId(team.id)} className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-all ${editExecutorId === team.id ? 'border-violet-500/50 bg-violet-500/10' : 'border-white/10 hover:border-white/20'}`}>
                      <span className={`text-xs font-medium ${editExecutorId === team.id ? 'text-violet-300' : 'text-zinc-400'}`}>{team.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Model</p>
              <div className="flex gap-2">
                {[{ id: 'haiku', label: 'Haiku' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'opus', label: 'Opus' }].map((m) => (
                  <button key={m.id} onClick={() => setEditModel(m.id)} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${editModel === m.id ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>{m.label}</button>
                ))}
              </div>
            </div>

            {/* Schedule */}
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">When to run</p>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <button onClick={() => setEditScheduleType('anytime')} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${editScheduleType === 'anytime' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Anytime</button>
                  <button onClick={() => setEditScheduleType('fixed')} className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${editScheduleType === 'fixed' ? 'border-violet-500/50 bg-violet-500/10 text-violet-300' : 'border-white/10 text-zinc-500 hover:border-white/20'}`}>Scheduled</button>
                </div>
                {editScheduleType === 'fixed' && (
                  <div className="space-y-3">
                    {/* Month & Year */}
                    <div className="flex items-center gap-2">
                      <div className="flex overflow-hidden rounded-lg border border-white/10">
                        {EDIT_MONTHS.map((m, i) => {
                          const disabled = eIsMonthDisabled(i)
                          return <button key={m} type="button" onClick={() => !disabled && setEditMonth(String(i))} className={`px-2 py-1.5 text-[10px] font-medium transition-all ${disabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : editMonth === String(i) ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-zinc-600 hover:text-zinc-400'}`}>{m}</button>
                        })}
                      </div>
                      <div className="flex overflow-hidden rounded-lg border border-white/10">
                        {[2026, 2027, 2028].map((y) => <button key={y} type="button" onClick={() => setEditYear(String(y))} className={`px-2.5 py-1.5 text-[10px] font-medium transition-all ${editYear === String(y) ? 'bg-violet-500/20 text-violet-300' : 'bg-white/5 text-zinc-600 hover:text-zinc-400'}`}>{y}</button>)}
                      </div>
                    </div>
                    {/* Day grid */}
                    <div>
                      <p className="mb-1 text-[10px] text-zinc-600">Day</p>
                      <div className="grid grid-cols-7 gap-1">
                        {Array.from({ length: 31 }, (_, i) => {
                          const d = String(i + 1).padStart(2, '0')
                          const disabled = eIsDayDisabled(i + 1)
                          const today = eSelYear === eNowYear && eSelMonth === eNowMonth && i + 1 === eNowDay
                          return <button key={d} type="button" onClick={() => !disabled && setEditDay(d)} className={`flex h-7 items-center justify-center rounded-md text-[11px] font-medium transition-all ${disabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : editDay === d ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30' : today ? 'bg-white/10 text-violet-400 ring-1 ring-violet-500/30' : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{i + 1}</button>
                        })}
                      </div>
                    </div>
                    {/* Time */}
                    <div>
                      <p className="mb-1 text-[10px] text-zinc-600">Time</p>
                      <div className="flex items-center gap-2">
                        <div className="grid grid-cols-6 gap-1">
                          {Array.from({ length: 12 }, (_, i) => {
                            const h = String(i + 1)
                            const disabled = eIsHourDisabled(i + 1, editPeriod)
                            return <button key={h} type="button" onClick={() => !disabled && setEditHour(h)} className={`flex h-7 w-8 items-center justify-center rounded-md text-[11px] font-medium transition-all ${disabled ? 'bg-white/[0.02] text-zinc-700 cursor-not-allowed' : editHour === h ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30' : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{h}</button>
                          })}
                        </div>
                        <span className="text-sm font-bold text-zinc-500">:</span>
                        <div className="flex flex-col gap-1">
                          {['00', '15', '30', '45'].map((m) => <button key={m} type="button" onClick={() => setEditMinute(m)} className={`flex h-7 w-10 items-center justify-center rounded-md text-[11px] font-medium transition-all ${editMinute === m ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30' : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{m}</button>)}
                        </div>
                        <div className="flex flex-col gap-1">
                          {(['AM', 'PM'] as const).map((p) => <button key={p} type="button" onClick={() => setEditPeriod(p)} className={`flex h-7 w-10 items-center justify-center rounded-md text-[11px] font-semibold transition-all ${editPeriod === p ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30' : 'bg-white/5 text-zinc-400 hover:bg-white/10 hover:text-zinc-200'}`}>{p}</button>)}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="flex gap-3 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
            <button onClick={handleSaveEdit} disabled={submitting} className="flex h-9 flex-1 items-center justify-center rounded-lg bg-violet-600 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-30">{submitting ? 'Saving...' : 'Save Changes'}</button>
            <button onClick={() => setMode('view')} className="flex h-9 items-center justify-center rounded-lg px-4 text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
          </div>
        </div>
      </div>
    )
  }

  // View mode (read-only)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">{task.name}</h2>
            <p className="text-[11px] text-zinc-500">Created {new Date(task.createdAt).toLocaleString()}</p>
          </div>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-6 space-y-4">
          {/* Report (clickable) */}
          {report && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Attached Report</p>
              <button onClick={() => setShowReportModal(true)} className="flex w-full items-center gap-3 rounded-lg border border-violet-500/20 bg-violet-500/[0.06] p-3 text-left transition-all hover:border-violet-500/40 hover:bg-violet-500/[0.1]">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/20">
                  <svg className="h-4 w-4 text-violet-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-violet-300 truncate">
                    {(report as Record<string, unknown>).parentTaskName
                      ? `Execution Report: ${String((report as Record<string, unknown>).parentTaskName)}`
                      : String((report as Record<string, unknown>).type) === 'team_build' ? 'Team Build Report'
                      : String((report as Record<string, unknown>).type) === 'team_discussion' ? 'Team Report'
                      : 'Build Report'}
                  </p>
                  <p className="text-[10px] text-zinc-500 truncate">{String((report as Record<string, unknown>).question ?? (report as Record<string, unknown>).conclusion ?? '')}</p>
                </div>
                <svg className="h-3.5 w-3.5 shrink-0 text-zinc-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
              </button>
            </div>
          )}

          {/* Context (clickable) */}
          {conversationSummary && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Conversation Context</p>
              <button onClick={() => setShowContextModal(true)} className="w-full rounded-lg border border-white/10 bg-white/[0.03] p-3 text-left transition-all hover:border-white/15 hover:bg-white/[0.05]">
                <p className="text-[11px] leading-relaxed text-zinc-400 line-clamp-3">{conversationSummary}</p>
                <p className="mt-1.5 text-[10px] text-zinc-600">Click to read full context</p>
              </button>
            </div>
          )}

          {/* Instruction */}
          {task.instruction && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Instructions</p>
              <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
                <p className="text-sm text-zinc-300">{task.instruction}</p>
              </div>
            </div>
          )}

          {/* Info row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[10px] text-zinc-500 mb-1">Assigned to</p>
              <div className="flex items-center gap-1.5">
                <svg className="h-3.5 w-3.5 text-zinc-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0" />
                </svg>
                <span className="text-xs font-medium text-zinc-200">{executorName}</span>
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[10px] text-zinc-500 mb-1">Intent</p>
              <span className={`text-xs font-medium ${intent?.color ?? 'text-zinc-400'}`}>{intent?.label ?? 'Not set'}</span>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[10px] text-zinc-500 mb-1">Schedule</p>
              {task.scheduledAt ? (
                <span className="text-xs font-medium text-amber-300">
                  {new Date(task.scheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  {' '}
                  {new Date(task.scheduledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                </span>
              ) : (
                <span className="text-xs font-medium text-violet-300">Anytime (queue)</span>
              )}
              {task.rescheduledReason && (
                <div className="mt-1.5 rounded border border-amber-500/20 bg-amber-500/5 px-2 py-1.5">
                  <p className="text-[10px] text-amber-400">
                    Rescheduled {task.rescheduledCount}x — {task.rescheduledReason}
                  </p>
                  {task.originalScheduledAt && (
                    <p className="text-[9px] text-zinc-500 mt-0.5">
                      Originally: {new Date(task.originalScheduledAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {new Date(task.originalScheduledAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[10px] text-zinc-500 mb-1">Model</p>
              <span className="text-xs font-medium text-zinc-200 capitalize">{task.accumulatedContext?.model ?? 'sonnet'}</span>
            </div>
          </div>

          {/* Fail reason banner */}
          {task.accumulatedContext?.failReason && (
            <div className="rounded-lg border border-red-500/20 bg-red-500/[0.06] p-3">
              <div className="flex items-start gap-2">
                <svg className="h-4 w-4 shrink-0 text-red-400 mt-0.5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                <div>
                  <p className="text-xs font-medium text-red-300">Task paused automatically</p>
                  <p className="mt-0.5 text-[11px] text-red-400/80">{task.accumulatedContext.failReason}</p>
                  {task.accumulatedContext.pausedState && (
                    <p className="mt-1 text-[10px] text-zinc-500">
                      Progress saved — {(task.accumulatedContext.pausedState as any).totalStepsCompleted ?? 0} steps completed. Task will continue from where it stopped when run again.
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-2 border-t border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
          {task.status === 'queue' && (
            <button onClick={handleRunTask} disabled={submitting} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z" />
              </svg>
              {submitting ? 'Starting...' : 'Run Now'}
            </button>
          )}
          <button onClick={() => setMode('edit')} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/10 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/5">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z" />
            </svg>
            Edit
          </button>
          <button onClick={() => setMode('delete')} className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-red-500/10 hover:text-red-400" title="Remove task">
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>
        </div>
      </div>

      {/* Report overlay */}
      {showReportModal && report && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => setShowReportModal(false)}>
          <div className="relative max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h2 className="text-sm font-semibold text-zinc-100">{report.type === 'team_discussion' ? 'Team Discussion Report' : report.type === 'team_build' ? 'Team Build Report' : 'Build Report'}</h2>
              <button onClick={() => setShowReportModal(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto p-6 space-y-4" style={{ maxHeight: 'calc(85vh - 72px)' }}>
              <div><p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Request</p><p className="text-sm text-zinc-300">{report.question}</p></div>
              {report.etapas && (report.etapas as any[]).length > 0 && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Pipeline — {(report.etapas as any[]).length} stages</p>
                  {(report.etapas as any[]).map((etapa: any, i: number) => (
                    <div key={i} className="mb-2 rounded-lg border border-white/10 bg-white/[0.02] p-3">
                      <p className="text-xs font-semibold text-zinc-200">{etapa.name}</p>
                      {(etapa.steps as any[])?.map((s: any, si: number) => (
                        <div key={si} className="mt-2 border-t border-white/5 pt-2">
                          <p className="text-[10px] font-semibold text-zinc-400">{s.employee} <span className="text-zinc-600">({s.role})</span></p>
                          <p className="mt-0.5 text-[11px] text-zinc-500 whitespace-pre-wrap">{s.output}</p>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {report.build && (
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Build — {(report.build as any).filesChanged.length} files</p>
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-1">
                    {((report.build as any).filesChanged as any[]).map((f: any, i: number) => (
                      <div key={i} className="flex items-center gap-2 text-[11px]">
                        <span className={`font-mono ${f.action === 'delete' ? 'text-red-400' : 'text-emerald-400'}`}>{f.action === 'delete' ? 'D' : 'M'}</span>
                        <span className="text-zinc-300">{f.path}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div><p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Conclusion</p><p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{report.conclusion}</p></div>
            </div>
          </div>
        </div>
      )}

      {/* Context overlay */}
      {showContextModal && conversationSummary && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70" onClick={() => setShowContextModal(false)}>
          <div className="relative max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ backgroundColor: '#1a1a22' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4" style={{ backgroundColor: '#15151c' }}>
              <h2 className="text-sm font-semibold text-zinc-100">Conversation Context</h2>
              <button onClick={() => setShowContextModal(false)} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-zinc-300">
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="overflow-y-auto p-6" style={{ maxHeight: 'calc(80vh - 64px)' }}>
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-zinc-300">{conversationSummary}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Task Intent Selector ───────────────────────────────────────────────────

const TASK_INTENTS: {
  id: 'build' | 'analyze_fix' | 'conversation'
  label: string
  icon: string
  color: string
  selectedBorder: string
  selectedBg: string
  selectedText: string
  info: string
}[] = [
  {
    id: 'build',
    label: 'Build',
    icon: 'M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085',
    color: 'text-emerald-400',
    selectedBorder: 'border-emerald-500/50',
    selectedBg: 'bg-emerald-500/10',
    selectedText: 'text-emerald-300',
    info: 'The team will plan and build. Code will be written, files created or edited, and changes pushed. Use this when you know exactly what needs to be implemented.',
  },
  {
    id: 'analyze_fix',
    label: 'Analyze & Fix',
    icon: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z',
    color: 'text-amber-400',
    selectedBorder: 'border-amber-500/50',
    selectedBg: 'bg-amber-500/10',
    selectedText: 'text-amber-300',
    info: 'The team will investigate and analyze first. If they find issues that need fixing, they can write code to resolve them. Best for bugs, performance issues, or when you\'re not sure what the solution is yet.',
  },
  {
    id: 'conversation',
    label: 'Review & Discuss',
    icon: 'M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155',
    color: 'text-sky-400',
    selectedBorder: 'border-sky-500/50',
    selectedBg: 'bg-sky-500/10',
    selectedText: 'text-sky-300',
    info: 'The team will only discuss, review, and analyze — no code changes. Use this for brainstorming, architecture reviews, security audits, code reviews, or when you just want expert opinions.',
  },
]

function TaskIntentSelector({
  value,
  onChange,
  hoveredInfo,
  onHoverInfo,
}: {
  value: 'build' | 'analyze_fix' | 'conversation'
  onChange: (v: 'build' | 'analyze_fix' | 'conversation') => void
  hoveredInfo: string | null
  onHoverInfo: (v: string | null) => void
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Task Intent</p>
      <div className="space-y-1.5">
        {TASK_INTENTS.map((intent) => {
          const selected = value === intent.id
          return (
            <div key={intent.id} className="relative">
              <button
                onClick={() => onChange(intent.id)}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all ${
                  selected
                    ? `${intent.selectedBorder} ${intent.selectedBg}`
                    : 'border-white/10 hover:border-white/20'
                }`}
              >
                <div className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                  selected ? `${intent.selectedBorder} ${intent.selectedBg}` : 'border-zinc-600'
                }`}>
                  {selected && <div className="h-1.5 w-1.5 rounded-full bg-current" style={{ color: intent.color.replace('text-', '').includes('emerald') ? '#34d399' : intent.color.includes('amber') ? '#fbbf24' : '#38bdf8' }} />}
                </div>
                <svg className={`h-4 w-4 ${selected ? intent.color : 'text-zinc-600'}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d={intent.icon} />
                </svg>
                <span className={`text-xs font-medium ${selected ? intent.selectedText : 'text-zinc-400'}`}>
                  {intent.label}
                </span>
                {/* Info button */}
                <div
                  className="relative ml-auto"
                  onMouseEnter={() => onHoverInfo(intent.id)}
                  onMouseLeave={() => onHoverInfo(null)}
                >
                  <div className="flex h-4 w-4 items-center justify-center rounded-full bg-white/5 text-[9px] font-bold text-zinc-500 hover:bg-white/10 hover:text-zinc-300">
                    i
                  </div>
                  {hoveredInfo === intent.id && (
                    <div className="absolute bottom-full right-0 z-30 mb-2 w-56 rounded-lg border border-white/10 p-3 shadow-xl" style={{ backgroundColor: '#15151c' }}>
                      <p className="text-[11px] leading-relaxed text-zinc-300">{intent.info}</p>
                    </div>
                  )}
                </div>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function EmptyCol({ label }: { label: string }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <p className="text-[11px] text-zinc-600">{label}</p>
    </div>
  )
}

function LoadingPlaceholder() {
  return (
    <div className="space-y-2">
      {[1, 2].map((i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg bg-white/5" />
      ))}
    </div>
  )
}

function getTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
