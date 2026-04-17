import { prisma } from '@/lib/db'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { LocalProvider } from '@/lib/compute-local'

// ── Repository Tools ──────────────────────────────────────────────────────
//
// All file operations go through the local filesystem or cloud sandbox.
// In local mode, commands execute directly on the user's machine.
// DB stores only metadata (tasks, chat, teams, etc.) — NOT files.

const compute = new LocalProvider()

// Read-only tools — available in ALL modes (conversation, review, analyze, build)
export const READ_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the content of a file in the repository',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to repo root (e.g. src/index.ts)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and directories at a given path',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path (empty string for root)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a text pattern across files in the repository. Returns matching lines with optional context.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Text or regex pattern to search for' },
        glob: { type: 'string', description: 'Optional file pattern filter (e.g. *.ts, src/**/*.tsx)' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'content = show matching lines (default), files_with_matches = only file paths, count = match counts per file',
        },
        context_lines: { type: 'number', description: 'Lines of context to show before and after each match (default 0, max 5)' },
        head_limit: { type: 'number', description: 'Max lines to return (default 50, pass 0 for unlimited)' },
        offset: { type: 'number', description: 'Skip first N lines — use with head_limit for pagination' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default true)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'glob',
    description: 'Find files by name pattern in the repository. Use this to locate files before reading them.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files (e.g. **/*.ts, src/**/*.tsx, *.json)' },
        path: { type: 'string', description: 'Directory to search in (default: repo root)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch the content of a URL. Use for reading documentation, API references, GitHub files, or any public web page.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        max_chars: { type: 'number', description: 'Max characters to return (default 20000)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'run_command_readonly',
    description: 'Run a read-only shell command to inspect the project state. Allowed: git log, git diff, git status, git show, git branch, cat, ls, find, npm list, node --version, npx tsc --noEmit, and similar inspection commands. NOT allowed: any command that writes files, installs packages, or modifies state.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Read-only shell command to run (e.g. git log --oneline -10, git diff HEAD~1, cat package.json)' },
      },
      required: ['command'],
    },
  },
]

// Write tools — only in build/fix modes
export const WRITE_TOOLS_DEFS = [
  {
    name: 'edit_file',
    description: 'Edit a specific part of a file by replacing old_string with new_string. Prefer this over write_file for targeted changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
        old_string: { type: 'string', description: 'Exact text to find and replace (must be unique in the file, include surrounding lines if needed)' },
        new_string: { type: 'string', description: 'Text to replace it with' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences instead of just the first (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or completely overwrite a file. Use edit_file for targeted changes to existing files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'The full file content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the repository',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path to delete' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the project terminal (npm install, npm run build, git, etc)',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  },
]

// Full tools — read + write (for build modes)
export const REPO_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS_DEFS]

// Note: previous "build session" gating was a global per-project lock used
// before worktree isolation existed. With per-chat worktrees, every chat's
// permission mode (Ask/Plan/Agent) already controls which tools are exposed
// to the model — so the gate is no longer needed and would block parallel
// work. The functions are kept as no-ops to avoid breaking external callers.

// ── Tool Executor ─────────────────────────────────────────────────────────

interface ToolResult {
  result: string
  isError: boolean
}

const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'delete_file'])

// Commands blocked in run_command_readonly — write/install operations
const READONLY_BLOCKED = /\b(npm install|npm i |yarn add|pnpm add|pip install|apt-get|apt |brew install|rm |rmdir|mv |cp |chmod|chown|mkdir|touch|tee |>\s|\|\s*sh|\|\s*bash|curl.*-o|wget)\b/i

// Output cap for run_command — prevents context bloat from large build logs
const RUN_COMMAND_MAX_CHARS = 30_000

// In-memory cache: sessionId → worktreePath. A chat's worktree assignment
// only changes when the chat is created or moved between worktrees, both
// rare events. Caching avoids a Prisma query on every single tool call.
const WORKTREE_CACHE = new Map<string, { path: string; expiresAt: number }>()
const WORKTREE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export function invalidateWorktreeCache(sessionId: string): void {
  WORKTREE_CACHE.delete(sessionId)
}

// Record that a chat session touched a particular file. Used to attribute
// per-chat diff stats on main, where multiple chats share the same working
// tree. Idempotent (skips push if the path is already recorded). Fire and
// forget — never blocks the tool result.
async function recordTouchedPath(sessionId: string, path: string): Promise<void> {
  try {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: { touchedPaths: true },
    })
    if (!session) return
    if (session.touchedPaths.includes(path)) return
    await prisma.chatSession.update({
      where: { id: sessionId },
      data: { touchedPaths: { push: path } },
    })
  } catch (err) {
    console.warn('[tools] failed to record touched path:', err)
  }
}

// Resolves the working directory for a tool call. If the chat session lives
// inside a worktree, returns that worktree's path. Otherwise (chat on main
// branch) falls back to the shared project root.
async function resolveProjectRoot(sessionId?: string): Promise<string> {
  if (!sessionId) return DEFAULT_PROJECT_ROOT

  const cached = WORKTREE_CACHE.get(sessionId)
  if (cached && Date.now() < cached.expiresAt) return cached.path

  try {
    const session = await prisma.chatSession.findUnique({
      where: { id: sessionId },
      select: {
        worktree: { select: { worktreePath: true } },
      },
    })
    const path = session?.worktree?.worktreePath ?? DEFAULT_PROJECT_ROOT
    WORKTREE_CACHE.set(sessionId, { path, expiresAt: Date.now() + WORKTREE_CACHE_TTL_MS })
    return path
  } catch {
    return DEFAULT_PROJECT_ROOT
  }
}

export async function executeTool(
  repositoryId: string,
  toolName: string,
  input: Record<string, unknown>,
  projectId?: string,
  sessionId?: string,
): Promise<ToolResult> {
  if (!projectId) return { result: 'No project context', isError: true }

  // Write authorization is enforced by the tool definitions exposed to Claude:
  // Ask/Plan modes only see READ_TOOLS, Agent mode sees REPO_TOOLS. The model
  // physically cannot call write_file/edit_file/delete_file outside Agent mode.
  const projectRoot = await resolveProjectRoot(sessionId)

  // Ensure sandbox is running for ALL operations — with retry on sandbox death
  for (let attempt = 0; attempt < 2; attempt++) {
    const sandboxId = await ensureSandboxRunning(projectId)
    if (!sandboxId) return { result: 'Failed to start sandbox. No container available.', isError: true }

    let result: ToolResult
    switch (toolName) {
      case 'read_file':
        result = await readFile(sandboxId, input.path as string, projectRoot); break
      case 'edit_file':
        result = await editFile(sandboxId, input.path as string, input.old_string as string, input.new_string as string, input.replace_all as boolean | undefined, projectRoot)
        if (!result.isError && sessionId) recordTouchedPath(sessionId, input.path as string).catch(() => {})
        break
      case 'write_file':
        result = await writeFile(sandboxId, input.path as string, input.content as string, projectRoot)
        if (!result.isError && sessionId) recordTouchedPath(sessionId, input.path as string).catch(() => {})
        break
      case 'list_dir':
        result = await listDir(sandboxId, input.path as string, projectRoot); break
      case 'search_files':
        result = await searchFiles(sandboxId, {
          query: input.query as string,
          glob: input.glob as string | undefined,
          outputMode: input.output_mode as 'content' | 'files_with_matches' | 'count' | undefined,
          contextLines: input.context_lines as number | undefined,
          headLimit: input.head_limit as number | undefined,
          offset: input.offset as number | undefined,
          caseInsensitive: input.case_insensitive as boolean | undefined,
        }, projectRoot); break
      case 'glob':
        result = await globFiles(sandboxId, input.pattern as string, input.path as string | undefined, projectRoot); break
      case 'web_fetch':
        return await webFetch(input.url as string, input.max_chars as number | undefined)
      case 'delete_file':
        result = await deleteFile(sandboxId, input.path as string, projectRoot)
        if (!result.isError && sessionId) recordTouchedPath(sessionId, input.path as string).catch(() => {})
        break
      case 'run_command':
        result = await runCommand(sandboxId, input.command as string, projectRoot); break
      case 'run_command_readonly':
        result = await runCommandReadonly(sandboxId, input.command as string, projectRoot); break
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true }
    }

    // If sandbox died mid-execution, force cleanup and retry once
    if (result.isError && result.result.includes('SANDBOX_DEAD')) {
      console.log('[tools] Sandbox dead, forcing recreation...')
      const { prisma: db } = await import('@/lib/db')
      await db.repository.update({ where: { projectId }, data: { sandboxId: null, sandboxStatus: 'stopped' } })
      continue
    }

    return result
  }

  return { result: 'Sandbox failed after retry. Please try again.', isError: true }
}

// ── All operations go to container ────────────────────────────────────────

// Dynamic in local mode — falls back to cwd when not resolved yet.
// Cloud mode used '/home/user/project'; local mode uses real disk path.
export const DEFAULT_PROJECT_ROOT = process.cwd()

const READ_FILE_MAX_CHARS = 100_000 // ~25K tokens — prevents context explosion on large files

async function readFile(sandboxId: string, path: string, projectRoot: string): Promise<ToolResult> {
  try {
    const content = await compute.readFile(sandboxId, `${projectRoot}/${path}`)
    if (content.length > READ_FILE_MAX_CHARS) {
      const preview = content.slice(0, READ_FILE_MAX_CHARS)
      const totalKB = Math.round(content.length / 1024)
      return {
        result: `${preview}\n\n[File truncated — ${totalKB}KB total, first ${Math.round(READ_FILE_MAX_CHARS / 1024)}KB shown. Use search_files to find specific sections.]`,
        isError: false,
      }
    }
    return { result: content, isError: false }
  } catch {
    return { result: `File not found: ${path}`, isError: true }
  }
}

async function editFile(
  sandboxId: string,
  path: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  projectRoot: string = DEFAULT_PROJECT_ROOT,
): Promise<ToolResult> {
  try {
    const content = await compute.readFile(sandboxId, `${projectRoot}/${path}`)

    if (!content.includes(oldString)) {
      // Give a useful hint — show the first 200 chars of the file so Claude can fix its old_string
      const preview = content.slice(0, 200)
      return {
        result: `old_string not found in ${path}. Make sure it matches exactly (including whitespace and indentation).\n\nFile starts with:\n${preview}`,
        isError: true,
      }
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (dir) await compute.exec(sandboxId, `mkdir -p ${projectRoot}/${dir}`)
    await compute.writeFile(sandboxId, `${projectRoot}/${path}`, updated)

    const occurrences = replaceAll
      ? content.split(oldString).length - 1
      : 1
    return { result: `Edited ${path} — replaced ${occurrences} occurrence${occurrences !== 1 ? 's' : ''}`, isError: false }
  } catch (err) {
    return { result: `Failed to edit ${path}: ${err instanceof Error ? err.message : 'Unknown'}`, isError: true }
  }
}

async function writeFile(sandboxId: string, path: string, content: string, projectRoot: string): Promise<ToolResult> {
  try {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (dir) {
      await compute.exec(sandboxId, `mkdir -p ${projectRoot}/${dir}`)
    }
    await compute.writeFile(sandboxId, `${projectRoot}/${path}`, content)
    return { result: `File written: ${path}`, isError: false }
  } catch (err) {
    return { result: `Failed to write ${path}: ${err instanceof Error ? err.message : 'Unknown'}`, isError: true }
  }
}

async function listDir(sandboxId: string, dirPath: string, projectRoot: string): Promise<ToolResult> {
  try {
    const fullPath = dirPath && dirPath !== '/' ? `${projectRoot}/${dirPath}` : projectRoot
    const result = await compute.exec(sandboxId, `ls -la ${fullPath}`)
    return { result: result.stdout || '(empty)', isError: false }
  } catch {
    return { result: `Directory not found: ${dirPath}`, isError: true }
  }
}

interface SearchOptions {
  query: string
  glob?: string
  outputMode?: 'content' | 'files_with_matches' | 'count'
  contextLines?: number
  headLimit?: number
  offset?: number
  caseInsensitive?: boolean
}

async function searchFiles(sandboxId: string, opts: SearchOptions, projectRoot: string): Promise<ToolResult> {
  try {
    const {
      query,
      glob,
      outputMode = 'content',
      contextLines = 0,
      headLimit = 50,
      offset = 0,
      caseInsensitive = true,
    } = opts

    // Check if rg is available, fall back to grep
    const rgCheck = await compute.exec(sandboxId, 'which rg 2>/dev/null || echo missing')
    const useRg = !rgCheck.stdout?.trim().includes('missing')

    let cmd: string
    if (useRg) {
      const flags: string[] = ['--no-heading']
      if (caseInsensitive) flags.push('-i')
      if (outputMode === 'files_with_matches') flags.push('-l')
      if (outputMode === 'count') flags.push('-c')
      if (outputMode === 'content') flags.push('-n')
      if (contextLines > 0) flags.push(`-C ${Math.min(contextLines, 5)}`)

      const typeFlags = glob
        ? `-g "${glob}"`
        : '--type-add "web:*.{ts,tsx,js,jsx,json,md,css,html,py,go,rs}" --type web'

      const escapedQuery = query.replace(/"/g, '\\"').replace(/`/g, '\\`')
      cmd = `cd ${projectRoot} && rg ${flags.join(' ')} ${typeFlags} -e "${escapedQuery}" 2>/dev/null`
    } else {
      // grep fallback
      const flags = ['-rn', caseInsensitive ? '-i' : ''].filter(Boolean)
      if (outputMode === 'files_with_matches') flags.push('-l')
      if (outputMode === 'count') flags.push('-c')
      if (contextLines > 0) flags.push(`-C ${Math.min(contextLines, 5)}`)
      const include = glob ? `--include="${glob}"` : '--include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.md" --include="*.css" --include="*.html"'
      const escapedQuery = query.replace(/"/g, '\\"').replace(/`/g, '\\`')
      cmd = `cd ${projectRoot} && grep ${flags.join(' ')} ${include} "${escapedQuery}" . 2>/dev/null`
    }

    // Apply pagination
    const paginationPipe = [
      offset > 0 ? `tail -n +${offset + 1}` : '',
      headLimit > 0 ? `head -${headLimit}` : '',
    ].filter(Boolean).join(' | ')

    const finalCmd = paginationPipe ? `${cmd} | ${paginationPipe}` : cmd
    const res = await compute.exec(sandboxId, finalCmd)
    const output = res.stdout?.trim()

    if (!output) return { result: `No matches found for "${query}"`, isError: false }

    const lineCount = output.split('\n').length
    const hint = headLimit > 0 && lineCount >= headLimit
      ? `\n\n[${lineCount} lines shown — use offset=${offset + headLimit} to see more]`
      : ''

    return { result: output + hint, isError: false }
  } catch {
    return { result: 'Search failed', isError: true }
  }
}

async function globFiles(sandboxId: string, pattern: string, searchPath: string | undefined, projectRoot: string): Promise<ToolResult> {
  try {
    const basePath = searchPath ? `${projectRoot}/${searchPath}` : projectRoot

    // Use find with proper glob support via -path for ** patterns
    // Convert glob pattern to find-compatible expression:
    //   **/*.ts  → find with -name "*.ts" (recursive by default)
    //   src/**   → find src/ with any name
    //   *.json   → find with -name "*.json" at any depth
    const namePattern = pattern
      .split('/')
      .pop()! // take the filename part (after last /)
      .replace(/\*\*/g, '*') // ** → * for -name

    // Build path constraint if pattern has directory prefix
    const dirPrefix = pattern.includes('/')
      ? pattern.slice(0, pattern.lastIndexOf('/')).replace(/\*\*/g, '*')
      : ''

    const pathConstraint = dirPrefix
      ? `-path "./${dirPrefix}/${namePattern}"`
      : `-name "${namePattern}"`

    const cmd = `cd ${basePath} && find . -not -path "./.git/*" -not -path "./node_modules/*" ${pathConstraint} 2>/dev/null | sed 's|^./||' | sort | head -200`

    const res = await compute.exec(sandboxId, cmd)
    const files = res.stdout?.trim()
    if (!files) return { result: `No files matched pattern: ${pattern}`, isError: false }

    const count = files.split('\n').length
    return { result: `${count} file${count !== 1 ? 's' : ''} matched:\n${files}`, isError: false }
  } catch {
    return { result: 'Glob search failed', isError: true }
  }
}

async function deleteFile(sandboxId: string, path: string, projectRoot: string): Promise<ToolResult> {
  try {
    // Sanitize: block path traversal attempts
    if (path.includes('..') || path.startsWith('/')) {
      return { result: `Invalid path: ${path}. Use relative paths within the project.`, isError: true }
    }
    const fullPath = `${projectRoot}/${path}`
    // Check file exists before deleting — rm -f silently succeeds on missing files
    const check = await compute.exec(sandboxId, `test -f ${fullPath} && echo exists || echo missing`)
    if (check.stdout?.trim() === 'missing') {
      return { result: `File not found: ${path}`, isError: true }
    }
    await compute.exec(sandboxId, `rm -f ${fullPath}`)
    return { result: `File deleted: ${path}`, isError: false }
  } catch {
    return { result: `Failed to delete: ${path}`, isError: true }
  }
}

async function webFetch(url: string, maxChars = 20_000): Promise<ToolResult> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Bornastar/1.0)' },
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      return { result: `HTTP ${res.status}: ${res.statusText} — ${url}`, isError: true }
    }

    const contentType = res.headers.get('content-type') ?? ''
    const text = await res.text()

    // Strip HTML tags for readability, keep text content
    const cleaned = contentType.includes('text/html')
      ? text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
      : text

    const capped = cleaned.slice(0, maxChars)
    const suffix = cleaned.length > maxChars
      ? `\n\n[Content truncated — ${Math.round(cleaned.length / 1024)}KB total, first ${Math.round(maxChars / 1024)}KB shown]`
      : ''

    return { result: capped + suffix, isError: false }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    return { result: `Failed to fetch ${url}: ${msg}`, isError: true }
  }
}

const RUN_COMMAND_TIMEOUT_MS = 120_000 // 2 min — prevents infinite loops from hanging commands

async function runCommand(sandboxId: string, command: string, projectRoot: string): Promise<ToolResult> {
  try {
    // Wrap command with timeout to prevent indefinite hangs. Auto-cd into the
    // chat's worktree so commands always operate in the right directory.
    const wrapped = `cd ${projectRoot} && ${command}`
    const timedCmd = `timeout ${RUN_COMMAND_TIMEOUT_MS / 1000}s bash -c ${JSON.stringify(wrapped)}`
    const result = await compute.exec(sandboxId, timedCmd)

    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')

    // Exit code 124 = timeout killed the process
    if (result.exitCode === 124) {
      return {
        result: `Command timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000}s.\nPartial output:\n${raw || '(none)'}`,
        isError: true,
      }
    }

    const output = raw || `(exit code: ${result.exitCode})`

    // Cap output to prevent context bloat
    if (output.length > RUN_COMMAND_MAX_CHARS) {
      const preview = output.slice(0, RUN_COMMAND_MAX_CHARS)
      const totalKB = Math.round(output.length / 1024)
      return {
        result: `${preview}\n\n[Output truncated — ${totalKB}KB total, first ${Math.round(RUN_COMMAND_MAX_CHARS / 1024)}KB shown]`,
        isError: result.exitCode !== 0,
      }
    }

    return { result: output, isError: result.exitCode !== 0 }
  } catch (err) {
    return { result: `Command failed: ${err instanceof Error ? err.message : 'Unknown'}`, isError: true }
  }
}

async function runCommandReadonly(sandboxId: string, command: string, projectRoot: string): Promise<ToolResult> {
  if (READONLY_BLOCKED.test(command)) {
    return {
      result: `Command blocked in read-only mode: "${command}". Only inspection commands are allowed (git log, git diff, git status, cat, ls, find, etc.).`,
      isError: true,
    }
  }
  // Use a shorter timeout for read-only commands — they should be fast
  const wrapped = `cd ${projectRoot} && ${command}`
  const timedCmd = `timeout 30s bash -c ${JSON.stringify(wrapped)}`
  try {
    const result = await compute.exec(sandboxId, timedCmd)
    const raw = [result.stdout, result.stderr].filter(Boolean).join('\n')
    if (result.exitCode === 124) {
      return { result: `Command timed out after 30s.\nPartial output:\n${raw || '(none)'}`, isError: true }
    }
    const output = raw || `(exit code: ${result.exitCode})`
    if (output.length > RUN_COMMAND_MAX_CHARS) {
      return {
        result: `${output.slice(0, RUN_COMMAND_MAX_CHARS)}\n\n[Output truncated]`,
        isError: result.exitCode !== 0,
      }
    }
    return { result: output, isError: result.exitCode !== 0 }
  } catch (err) {
    return { result: `Command failed: ${err instanceof Error ? err.message : 'Unknown'}`, isError: true }
  }
}
