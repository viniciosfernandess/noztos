// ── Chunker ───────────────────────────────────────────────────────────────
//
// Splits files into semantically meaningful chunks for embedding.
//
// Strategy by file type:
//   .ts / .tsx / .js / .jsx  → split by top-level exports/declarations
//   .md                       → split by ## sections
//   .json                     → whole file (small configs)
//   other                     → whole file if ≤ 200 lines, else 100-line windows

export interface Chunk {
  filePath: string
  chunkType: 'function' | 'component' | 'class' | 'section' | 'file' | 'config'
  chunkName: string | null
  content: string
  lineStart: number
  lineEnd: number
  imports: string[]  // files this chunk imports (for import graph)
}

// ── Import extraction ─────────────────────────────────────────────────────

function extractImports(content: string, filePath: string): string[] {
  const dir = filePath.split('/').slice(0, -1).join('/')
  const imports: string[] = []

  const re = /(?:import|from)\s+['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    const raw = m[1]
    // Only local imports (relative paths)
    if (!raw.startsWith('.')) continue

    // Resolve relative path
    const parts = (dir + '/' + raw).split('/').filter(Boolean)
    const resolved: string[] = []
    for (const p of parts) {
      if (p === '..') resolved.pop()
      else if (p !== '.') resolved.push(p)
    }
    imports.push(resolved.join('/'))
  }

  return [...new Set(imports)]
}

// ── TypeScript/JavaScript chunker ─────────────────────────────────────────

const TS_DECLARATION = /^(?:export\s+)?(?:async\s+)?(?:function|const|class|interface|type|enum|default)\s+(\w+)/

function chunkTypeScript(filePath: string, content: string): Chunk[] {
  const lines = content.split('\n')
  const fileImports = extractImports(content, filePath)

  const chunks: Chunk[] = []
  let blockStart = -1
  let blockName: string | null = null
  let blockType: Chunk['chunkType'] = 'function'
  let depth = 0
  let inBlock = false

  const flush = (end: number) => {
    if (blockStart === -1) return
    const blockLines = lines.slice(blockStart, end)
    const blockContent = blockLines.join('\n').trim()
    if (blockContent.length > 20) {
      chunks.push({
        filePath,
        chunkType: blockType,
        chunkName: blockName,
        content: blockContent,
        lineStart: blockStart + 1,
        lineEnd: end,
        imports: fileImports,
      })
    }
    blockStart = -1
    blockName = null
    depth = 0
    inBlock = false
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!inBlock) {
      // Look for top-level declaration start
      const isExport = trimmed.startsWith('export ')
      const decl = TS_DECLARATION.exec(trimmed)
      if (decl || (isExport && trimmed.includes('{'))) {
        flush(i)
        blockStart = i
        blockName = decl?.[1] ?? null

        if (trimmed.includes('function') || trimmed.includes('async')) blockType = 'function'
        else if (trimmed.includes('class')) blockType = 'class'
        else if (trimmed.includes('const') && /=>|function/.test(content.slice(content.indexOf(decl?.[0] ?? ''), content.indexOf(decl?.[0] ?? '') + 200))) blockType = 'function'
        else blockType = 'function'

        // Check if this is a React component (PascalCase export)
        if (blockName && /^[A-Z]/.test(blockName)) blockType = 'component'
        inBlock = true
      }
    }

    if (inBlock) {
      depth += (line.match(/\{/g) || []).length
      depth -= (line.match(/\}/g) || []).length

      // Block ended when depth returns to 0 after opening
      if (depth <= 0 && i > blockStart) {
        flush(i + 1)
      }
    }
  }

  // Flush any remaining
  if (inBlock && blockStart !== -1) {
    flush(lines.length)
  }

  // If no chunks found, treat whole file as one chunk
  if (chunks.length === 0 && content.trim()) {
    chunks.push({
      filePath,
      chunkType: 'file',
      chunkName: filePath.split('/').pop() ?? null,
      content: content.slice(0, 8000),
      lineStart: 1,
      lineEnd: lines.length,
      imports: fileImports,
    })
  }

  return chunks
}

// ── Markdown chunker ──────────────────────────────────────────────────────

function chunkMarkdown(filePath: string, content: string): Chunk[] {
  const lines = content.split('\n')
  const chunks: Chunk[] = []

  let sectionStart = 0
  let sectionTitle: string | null = null

  const flush = (end: number) => {
    const sectionLines = lines.slice(sectionStart, end)
    const sectionContent = sectionLines.join('\n').trim()
    if (sectionContent.length > 20) {
      chunks.push({
        filePath,
        chunkType: 'section',
        chunkName: sectionTitle,
        content: sectionContent,
        lineStart: sectionStart + 1,
        lineEnd: end,
        imports: [],
      })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,3}\s/.test(line) && i > 0) {
      flush(i)
      sectionStart = i
      sectionTitle = line.replace(/^#+\s*/, '').trim()
    }
  }

  flush(lines.length)

  if (chunks.length === 0 && content.trim()) {
    chunks.push({
      filePath,
      chunkType: 'section',
      chunkName: filePath.split('/').pop() ?? null,
      content: content.slice(0, 8000),
      lineStart: 1,
      lineEnd: lines.length,
      imports: [],
    })
  }

  return chunks
}

// ── Generic chunker ───────────────────────────────────────────────────────

function chunkGeneric(filePath: string, content: string): Chunk[] {
  const lines = content.split('\n')
  const WINDOW = 100

  if (lines.length <= 200) {
    return [{
      filePath,
      chunkType: 'config',
      chunkName: filePath.split('/').pop() ?? null,
      content: content.slice(0, 8000),
      lineStart: 1,
      lineEnd: lines.length,
      imports: [],
    }]
  }

  const chunks: Chunk[] = []
  for (let i = 0; i < lines.length; i += WINDOW) {
    const end = Math.min(i + WINDOW, lines.length)
    chunks.push({
      filePath,
      chunkType: 'file',
      chunkName: `${filePath.split('/').pop()}_${i + 1}`,
      content: lines.slice(i, end).join('\n'),
      lineStart: i + 1,
      lineEnd: end,
      imports: [],
    })
  }
  return chunks
}

// ── Public API ────────────────────────────────────────────────────────────

const SKIP_PATTERNS = /\.(lock|log|map|ico|png|jpg|jpeg|gif|svg|woff|woff2|ttf|eot|bin|zip)$/i
const MAX_FILE_SIZE = 50_000 // 50KB — skip huge files

/**
 * Chunk a file into embeddable pieces.
 * Returns empty array if file should be skipped.
 */
export function chunkFile(filePath: string, content: string): Chunk[] {
  if (SKIP_PATTERNS.test(filePath)) return []
  if (content.length > MAX_FILE_SIZE) return []
  if (!content.trim()) return []

  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''

  if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) return chunkTypeScript(filePath, content)
  if (ext === 'md') return chunkMarkdown(filePath, content)
  return chunkGeneric(filePath, content)
}
