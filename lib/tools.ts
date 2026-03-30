import { prisma } from '@/lib/db'
import { ensureSandboxRunning } from '@/lib/sandbox-manager'
import { E2BProvider } from '@/lib/compute-e2b'

// ── Repository Tools ──────────────────────────────────────────────────────
//
// All file operations go through the container (single source of truth).
// Container auto-starts when needed.
// DB stores only metadata (tasks, chat, teams, etc.) — NOT files.

const compute = new E2BProvider()

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
    description: 'Search for a text pattern across files in the repository',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Text to search for' },
        glob: { type: 'string', description: 'Optional file pattern filter (e.g. *.ts)' },
      },
      required: ['query'],
    },
  },
]

// Write tools — only in build/fix modes
export const WRITE_TOOLS_DEFS = [
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the repository',
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

// ── Build Session Management ──────────────────────────────────────────────

export async function checkBuildAuthorization(projectId: string): Promise<boolean> {
  const session = await prisma.buildSession.findFirst({ where: { projectId, active: true } })
  return !!session
}

export async function createBuildSession(projectId: string, userId: string, buildWith: string): Promise<void> {
  await prisma.buildSession.updateMany({ where: { projectId, active: true }, data: { active: false } })
  await prisma.buildSession.create({ data: { projectId, userId, buildWith } })
}

export async function endBuildSession(projectId: string): Promise<void> {
  await prisma.buildSession.updateMany({ where: { projectId, active: true }, data: { active: false } })
}

// ── Tool Executor ─────────────────────────────────────────────────────────

interface ToolResult {
  result: string
  isError: boolean
}

const WRITE_TOOLS = new Set(['write_file', 'delete_file'])

export async function executeTool(
  repositoryId: string,
  toolName: string,
  input: Record<string, unknown>,
  projectId?: string
): Promise<ToolResult> {
  if (!projectId) return { result: 'No project context', isError: true }

  // Gate: write operations require active build session
  if (WRITE_TOOLS.has(toolName)) {
    const authorized = await checkBuildAuthorization(projectId)
    if (!authorized) {
      return {
        result: 'BUILD NOT AUTHORIZED. Ask the user for confirmation before writing or deleting files.',
        isError: true,
      }
    }
  }

  // Ensure sandbox is running for ALL operations
  const sandboxId = await ensureSandboxRunning(projectId)
  if (!sandboxId) return { result: 'Failed to start sandbox. No container available.', isError: true }

  switch (toolName) {
    case 'read_file':
      return readFile(sandboxId, input.path as string)
    case 'write_file':
      return writeFile(sandboxId, input.path as string, input.content as string)
    case 'list_dir':
      return listDir(sandboxId, input.path as string)
    case 'search_files':
      return searchFiles(sandboxId, input.query as string, input.glob as string | undefined)
    case 'delete_file':
      return deleteFile(sandboxId, input.path as string)
    case 'run_command':
      return runCommand(sandboxId, input.command as string)
    default:
      return { result: `Unknown tool: ${toolName}`, isError: true }
  }
}

// ── All operations go to container ────────────────────────────────────────

const PROJECT_ROOT = '/home/user/project'

async function readFile(sandboxId: string, path: string): Promise<ToolResult> {
  try {
    const content = await compute.readFile(sandboxId, `${PROJECT_ROOT}/${path}`)
    return { result: content, isError: false }
  } catch {
    return { result: `File not found: ${path}`, isError: true }
  }
}

async function writeFile(sandboxId: string, path: string, content: string): Promise<ToolResult> {
  try {
    // Ensure directory exists
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    if (dir) {
      await compute.exec(sandboxId, `mkdir -p ${PROJECT_ROOT}/${dir}`)
    }
    await compute.writeFile(sandboxId, `${PROJECT_ROOT}/${path}`, content)
    return { result: `File written: ${path}`, isError: false }
  } catch (err) {
    return { result: `Failed to write ${path}: ${err instanceof Error ? err.message : 'Unknown'}`, isError: true }
  }
}

async function listDir(sandboxId: string, dirPath: string): Promise<ToolResult> {
  try {
    const fullPath = dirPath && dirPath !== '/' ? `${PROJECT_ROOT}/${dirPath}` : PROJECT_ROOT
    const result = await compute.exec(sandboxId, `ls -la ${fullPath}`)
    return { result: result.stdout || '(empty)', isError: false }
  } catch {
    return { result: `Directory not found: ${dirPath}`, isError: true }
  }
}

async function searchFiles(sandboxId: string, query: string, glob?: string): Promise<ToolResult> {
  try {
    const globArg = glob ? `--include="${glob}"` : ''
    const result = await compute.exec(sandboxId, `cd ${PROJECT_ROOT} && grep -rn ${globArg} -i "${query}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.md" --include="*.css" --include="*.html" --include="*.py" --include="*.go" --include="*.rs" . 2>/dev/null | head -50`)
    return { result: result.stdout || `No matches found for "${query}"`, isError: false }
  } catch {
    return { result: `Search failed`, isError: true }
  }
}

async function deleteFile(sandboxId: string, path: string): Promise<ToolResult> {
  try {
    const result = await compute.exec(sandboxId, `rm -f ${PROJECT_ROOT}/${path}`)
    if (result.exitCode !== 0) return { result: `Failed to delete: ${path}`, isError: true }
    return { result: `File deleted: ${path}`, isError: false }
  } catch {
    return { result: `Failed to delete: ${path}`, isError: true }
  }
}

async function runCommand(sandboxId: string, command: string): Promise<ToolResult> {
  try {
    const result = await compute.exec(sandboxId, command)
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return { result: output || `(exit code: ${result.exitCode})`, isError: result.exitCode !== 0 }
  } catch (err) {
    return { result: `Command failed: ${err instanceof Error ? err.message : 'Unknown'}`, isError: true }
  }
}
