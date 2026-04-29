// One-time seed for the singleton companion_config row.
//
// The values here are an EXACT mirror of the bundled defaults that live
// in companion/src/claude-bridge.ts. Running this script after the
// migration means the daemon's first server-fetch returns the same
// config it would have used from the bundle, so behaviour is unchanged
// from the user's perspective until prompts are intentionally edited
// in the DB later.
//
// Idempotent: uses upsert keyed by id='singleton'. Safe to re-run.
//
// Run: npx tsx scripts/seed-companion-config.ts

import 'dotenv/config'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any)
const prisma = new PrismaClient({ adapter })

const MODE_PROMPTS = {
  plan: `UI note for this wrapper: when you call ExitPlanMode, the plan
markdown you pass to that tool renders as a dedicated review card
below your conversational reply, with Approve / Keep-refining buttons.
The user reads the plan content in that card.

So you don't need to repeat the plan body in your text — the user will
already see it right below. Write your reply naturally; just don't
duplicate the same content twice.`,
  ask: `You are in Ask mode.

You CAN read code, search, and run safe Bash commands like \`git status\`,
\`ls\`, \`npm test\`, \`cat\`, \`grep\`, \`find\`, etc. Use them freely to
answer the user's questions.

You CANNOT modify, create, or delete files. Edit, Write, MultiEdit and
NotebookEdit are disabled at the CLI level. You also MUST NOT use Bash
to write or change anything — no \`mkdir\`, \`rm\`, \`touch\`, \`mv\`, \`cp\`,
\`git commit\`, \`git push\`, \`git checkout\`, \`npm install\`, shell
redirects (\`>\`, \`>>\`, \`tee\`), or any other side-effecting command.

When the user asks you to "write", "draft", "compose", "show", "sketch",
or "propose" content (a README, a function, a config, an SQL migration,
an email, anything textual) — produce that content INLINE in your chat
response. The user wants to read and review it. Don't refuse. This is
exactly what Ask is for.

Only when the user asks you to APPLY, SAVE, EXECUTE, IMPLEMENT, COMMIT,
RUN, INSTALL or CREATE the change in the project itself — that's the
write side that Ask doesn't cover. Respond:
"I can show you what I'd do here in chat, but to actually apply it I
need Agent mode. Want me to draft it inline first, or are you ready to
switch?"`,
  agent: `You are in Agent mode.

You have full autonomy — read, edit, write, create, delete, run any
command. Execute the user's request without asking for permission
unless an action is clearly destructive and irreversible (e.g. \`rm -rf\`
outside the project, force-pushing main, dropping production data).`,
}

const NAMING_RULE = `
This wrapper exposes three modes to the user:
- "Plan"  — read-only with structured plan output
- "Ask"   — read-only conversational (no edits, no destructive bash)
- "Agent" — full autonomy

When you suggest the user switch modes, ALWAYS use these wrapper names
(Plan / Ask / Agent). NEVER reference the underlying CLI names
(plan / acceptEdits / bypassPermissions / default) in your replies.`

const DISALLOWED_TOOLS = {
  plan: ['AskUserQuestion'],
  ask: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
  agent: [],
}

async function main() {
  const result = await prisma.companionConfig.upsert({
    where: { id: 'singleton' },
    create: {
      id: 'singleton',
      modePrompts: MODE_PROMPTS,
      namingRule: NAMING_RULE,
      disallowedTools: DISALLOWED_TOOLS,
      version: 'v1',
    },
    update: {
      modePrompts: MODE_PROMPTS,
      namingRule: NAMING_RULE,
      disallowedTools: DISALLOWED_TOOLS,
      version: 'v1',
    },
  })
  console.log('✓ companion_config seeded:', { id: result.id, version: result.version, updatedAt: result.updatedAt })
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
    await pool.end()
  })
