// Test helper — bumps the companion_config version and tweaks the
// agent prompt slightly. Used to verify the daemon's fetch path
// actually reads from the DB after a change. Idempotent toggle: re-run
// flips between v1 and v-test so the script doubles as cleanup.

import 'dotenv/config'
import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../generated/prisma/client'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = new PrismaPg(pool as any)
const prisma = new PrismaClient({ adapter })

async function main() {
  const cur = await prisma.companionConfig.findUnique({ where: { id: 'singleton' } })
  if (!cur) { console.error('No config row'); return }

  const goingToTest = cur.version === 'v1'
  const newVersion = goingToTest ? 'v-test' : 'v1'
  const prompts = cur.modePrompts as Record<string, string>
  const newAgentPrompt = goingToTest
    ? prompts.agent + '\n\n[TEST MARKER — server v-test injected]'
    : prompts.agent.replace(/\n\n\[TEST MARKER — server v-test injected]$/, '')

  await prisma.companionConfig.update({
    where: { id: 'singleton' },
    data: {
      version: newVersion,
      modePrompts: {
        ...prompts,
        agent: newAgentPrompt,
      },
    },
  })
  console.log(`✓ companion_config bumped: ${cur.version} → ${newVersion}`)
  console.log(`  Agent prompt size: ${newAgentPrompt.length} bytes`)
  console.log(`  Now restart bornastar to see configVersion=${newVersion} on startup,`)
  console.log(`  OR wait up to 5min for the polling drift detector to refresh.`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(async () => { await prisma.$disconnect(); await pool.end() })
