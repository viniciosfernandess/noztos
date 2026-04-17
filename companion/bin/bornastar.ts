#!/usr/bin/env node

import { Command } from 'commander'
import { resolve } from 'node:path'
import { getClaudeInfo } from '../src/auth-detect.js'
import { initProject, listProjects, cloneRepo, createProject, unregisterProject } from '../src/project-manager.js'
import { loadConfig, setAuthToken, setServerUrl } from '../src/config.js'
import { Daemon } from '../src/daemon.js'

const program = new Command()

program
  .name('bornastar')
  .description('Bornastar companion — bridges your local Claude Code to the Bornastar web IDE')
  .version('0.1.0')

// ── bornastar init ──────────────────────────────────────────────────
// Registers the current directory as a Bornastar project
program
  .command('init')
  .description('Register the current directory as a Bornastar project')
  .argument('[path]', 'Project directory (defaults to cwd)', '.')
  .action((pathArg: string) => {
    try {
      const project = initProject(resolve(pathArg))
      console.log(`\n  ✅ Project registered: ${project.name}`)
      console.log(`     Path: ${project.path}`)
      if (project.gitRemote) console.log(`     Remote: ${project.gitRemote}`)
      console.log(`\n  Open bornastar.com to start coding.\n`)
    } catch (err) {
      console.error(`\n  ❌ ${(err as Error).message}\n`)
      process.exit(1)
    }
  })

// ── bornastar start ─────────────────────────────────────────────────
// Starts the background daemon that connects to the Bornastar server
program
  .command('start')
  .description('Start the Bornastar daemon (connects to bornastar.com)')
  .option('--foreground', 'Run in foreground (don\'t daemonize)')
  .action(async (opts: { foreground?: boolean }) => {
    const config = loadConfig()
    if (!config.authToken) {
      console.error('\n  ❌ Not authenticated. Run `bornastar login` first.\n')
      process.exit(1)
    }

    // Check Claude Code
    const claude = getClaudeInfo()
    if (!claude.auth.installed) {
      console.error('\n  ❌ Claude Code not found.')
      console.error('     Install it: curl -fsSL https://claude.ai/install.sh | bash\n')
      process.exit(1)
    }
    if (!claude.auth.authenticated) {
      console.error('\n  ❌ Claude Code not authenticated.')
      console.error('     Run: claude login\n')
      process.exit(1)
    }

    console.log('\n  🚀 Bornastar companion starting...')
    console.log(`     Claude Code: ${claude.version ?? 'unknown'}`)
    console.log(`     Auth: ${claude.auth.email ?? 'authenticated'} (${claude.auth.plan ?? 'subscription'})`)
    console.log(`     Projects: ${config.projects.length} registered`)
    console.log(`     Server: ${config.serverUrl}`)
    console.log()

    const daemon = new Daemon(config.serverUrl, config.authToken)

    daemon.on('connected', () => {
      console.log('  ✅ Connected to Bornastar server')
      console.log('     Open bornastar.com to start coding.\n')
      if (!opts.foreground) {
        console.log('  Tip: Press Ctrl+C to stop the daemon.\n')
      }
    })

    daemon.on('disconnected', () => {
      console.log('  ⚠️  Disconnected. Reconnecting...')
    })

    daemon.on('error', (err: Error) => {
      console.error(`  ❌ Error: ${err.message}`)
    })

    // Graceful shutdown
    process.on('SIGINT', () => {
      console.log('\n  Shutting down...')
      daemon.stop()
      process.exit(0)
    })
    process.on('SIGTERM', () => {
      daemon.stop()
      process.exit(0)
    })

    await daemon.start()
  })

// ── bornastar status ────────────────────────────────────────────────
program
  .command('status')
  .description('Show companion status, Claude auth, and registered projects')
  .action(() => {
    const config = loadConfig()
    const claude = getClaudeInfo()

    console.log('\n  Bornastar Companion Status')
    console.log('  ─────────────────────────')

    // Auth
    console.log(`\n  Bornastar: ${config.authToken ? '✅ Authenticated' : '❌ Not authenticated'}`)
    console.log(`  Server:    ${config.serverUrl}`)

    // Claude
    console.log(`\n  Claude Code: ${claude.auth.installed ? `✅ Installed (${claude.version ?? 'unknown'})` : '❌ Not installed'}`)
    if (claude.auth.installed) {
      console.log(`  Claude Auth: ${claude.auth.authenticated ? `✅ ${claude.auth.email ?? 'authenticated'} (${claude.auth.plan ?? 'subscription'})` : '❌ Not logged in'}`)
    }

    // Projects
    console.log(`\n  Projects (${config.projects.length}):`)
    if (config.projects.length === 0) {
      console.log('    None. Run `bornastar init` in a project directory.')
    } else {
      for (const p of config.projects) {
        console.log(`    • ${p.name} — ${p.path}`)
      }
    }
    console.log()
  })

// ── bornastar login ─────────────────────────────────────────────────
program
  .command('login')
  .description('Authenticate with your Bornastar account')
  .argument('<token>', 'Auth token from bornastar.com/settings')
  .action((token: string) => {
    setAuthToken(token)
    console.log('\n  ✅ Authenticated. Run `bornastar start` to connect.\n')
  })

// ── bornastar projects ──────────────────────────────────────────────
program
  .command('projects')
  .description('List registered projects')
  .action(() => {
    const projects = listProjects()
    if (projects.length === 0) {
      console.log('\n  No projects registered. Run `bornastar init` in a project directory.\n')
      return
    }
    console.log(`\n  Registered projects (${projects.length}):\n`)
    for (const p of projects) {
      console.log(`    ${p.name}`)
      console.log(`      Path:   ${p.path}`)
      if (p.gitRemote) console.log(`      Remote: ${p.gitRemote}`)
      console.log()
    }
  })

// ── bornastar clone ─────────────────────────────────────────────────
program
  .command('clone')
  .description('Clone a GitHub repo and register it')
  .argument('<url>', 'Repository URL')
  .argument('[path]', 'Target directory')
  .action((url: string, pathArg?: string) => {
    const repoName = url.split('/').pop()?.replace('.git', '') ?? 'project'
    const targetDir = resolve(pathArg ?? repoName)
    try {
      console.log(`\n  Cloning ${url}...`)
      const project = cloneRepo(url, targetDir)
      console.log(`  ✅ Cloned and registered: ${project.name}`)
      console.log(`     Path: ${project.path}\n`)
    } catch (err) {
      console.error(`\n  ❌ ${(err as Error).message}\n`)
      process.exit(1)
    }
  })

// ── bornastar create ────────────────────────────────────────────────
program
  .command('create')
  .description('Create a new project from scratch')
  .argument('<name>', 'Project name')
  .option('-t, --template <template>', 'Template (nextjs, vite, python, node)')
  .action((name: string, opts: { template?: string }) => {
    const targetDir = resolve(name)
    try {
      console.log(`\n  Creating project "${name}"${opts.template ? ` with ${opts.template} template` : ''}...`)
      const project = createProject(targetDir, { template: opts.template })
      console.log(`  ✅ Created and registered: ${project.name}`)
      console.log(`     Path: ${project.path}\n`)
    } catch (err) {
      console.error(`\n  ❌ ${(err as Error).message}\n`)
      process.exit(1)
    }
  })

// ── bornastar remove ────────────────────────────────────────────────
program
  .command('remove')
  .description('Unregister a project (does not delete files)')
  .argument('[path]', 'Project directory (defaults to cwd)', '.')
  .action((pathArg: string) => {
    unregisterProject(resolve(pathArg))
    console.log('\n  ✅ Project unregistered.\n')
  })

// ── bornastar server ────────────────────────────────────────────────
program
  .command('server')
  .description('Set the Bornastar server URL (for self-hosted or dev)')
  .argument('<url>', 'Server URL (e.g. http://localhost:3000)')
  .action((url: string) => {
    setServerUrl(url)
    console.log(`\n  ✅ Server set to: ${url}\n`)
  })

program.parse()
