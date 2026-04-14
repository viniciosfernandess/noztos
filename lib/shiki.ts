// Shiki highlighter — gives us VS Code–quality syntax coloring using
// TextMate grammars and the official VS Code Dark+ theme. We keep a single
// highlighter instance (cached by shiki internally) so repeat highlights are
// cheap, and expose a small API that returns HTML-per-line which our file
// viewers can render with preserved wrap/line-numbers.

import { createHighlighter, type Highlighter } from 'shiki'

const LANGUAGES = [
  'typescript', 'tsx', 'javascript', 'jsx', 'json', 'css', 'scss',
  'python', 'bash', 'shell', 'yaml', 'markdown', 'sql', 'html', 'xml',
  'rust', 'go', 'java', 'c', 'cpp', 'csharp', 'php', 'ruby',
] as const

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  mjs: 'javascript', cjs: 'javascript',
  json: 'json', css: 'css', scss: 'scss',
  py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash',
  yml: 'yaml', yaml: 'yaml', md: 'markdown', mdx: 'markdown',
  sql: 'sql', html: 'html', htm: 'html', xml: 'xml',
  rs: 'rust', go: 'go', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby',
}

export function getLanguageFromFilename(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext] ?? 'text'
}

// Theme choice: "one-dark-pro" has punchier, more saturated colors than
// VS Code's default "dark-plus" — matches Conductor/Cursor vibe better.
const THEME = 'one-dark-pro' as const

let highlighterPromise: Promise<Highlighter> | null = null

function loadHighlighter(): Promise<Highlighter> {
  if (highlighterPromise) return highlighterPromise
  highlighterPromise = createHighlighter({
    themes: [THEME],
    langs: LANGUAGES as unknown as string[],
  })
  return highlighterPromise
}

/**
 * Highlight source code and return one HTML string per line. Whitespace is
 * preserved via inline styles (from the theme) so the caller can still apply
 * `white-space: pre-wrap` for wrapping long lines.
 *
 * Falls back to plain-text lines on error so the UI never breaks.
 */
export async function highlightLines(code: string, lang: string): Promise<string[]> {
  try {
    const hl = await loadHighlighter()
    const resolvedLang = hl.getLoadedLanguages().includes(lang) ? lang : 'text'
    const html = hl.codeToHtml(code, { lang: resolvedLang, theme: THEME })
    // shiki returns <pre><code><span class="line">...</span>\n<span class="line">...</span></code></pre>
    // Extract the inner HTML of each line span.
    const lineRegex = /<span class="line">([\s\S]*?)<\/span>(?=\n|<\/code>)/g
    const lines: string[] = []
    let match
    while ((match = lineRegex.exec(html)) !== null) {
      lines.push(match[1])
    }
    // Guarantee one entry per source line — shiki may omit trailing empty lines
    const expected = code.split('\n').length
    while (lines.length < expected) lines.push('')
    return lines
  } catch {
    // Fallback — plain escaped lines
    return code.split('\n').map((l) => escapeHtml(l))
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
