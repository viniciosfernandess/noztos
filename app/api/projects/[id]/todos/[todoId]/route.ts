import { NextRequest, NextResponse } from 'next/server'
import { verifyProjectAccess } from '@/lib/auth'
import { prisma } from '@/lib/db'

interface RouteContext { params: Promise<{ id: string; todoId: string }> }

// Guard that the todo belongs to this project, via its worktree or session.
async function loadAuthorizedTodo(projectId: string, todoId: string) {
  const todo = await prisma.todo.findUnique({
    where: { id: todoId },
    select: {
      id: true, content: true, done: true, position: true,
      worktree: { select: { projectId: true } },
      session: { select: { projectId: true } },
    },
  })
  if (!todo) return null
  const owningProject = todo.worktree?.projectId ?? todo.session?.projectId
  if (owningProject !== projectId) return null
  return todo
}

// PATCH — toggle done, change content, or move position. Body is a partial
// of { content?: string; done?: boolean; position?: number }. Absent fields
// are left untouched.
export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id, todoId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const existing = await loadAuthorizedTodo(id, todoId)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let body: { content?: string; done?: boolean; position?: number } = {}
  try { body = await request.json() } catch {}

  const data: { content?: string; done?: boolean; position?: number } = {}
  if (typeof body.content === 'string' && body.content.trim().length > 0) data.content = body.content.trim()
  if (typeof body.done === 'boolean') data.done = body.done
  if (typeof body.position === 'number' && Number.isFinite(body.position)) data.position = body.position
  if (Object.keys(data).length === 0) return NextResponse.json({ error: 'nothing to update' }, { status: 400 })

  const updated = await prisma.todo.update({
    where: { id: todoId },
    data,
    select: { id: true, content: true, done: true, position: true, createdAt: true },
  })
  return NextResponse.json(updated)
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id, todoId } = await context.params
  const auth = await verifyProjectAccess(id)
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const existing = await loadAuthorizedTodo(id, todoId)
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 })

  await prisma.todo.delete({ where: { id: todoId } })
  return NextResponse.json({ ok: true })
}
