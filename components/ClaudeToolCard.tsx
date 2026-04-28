'use client'

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { ChatMessage } from '@/lib/hooks/useCompanionStream'

// Maps file extensions to Prism language names. Mirrors the Monaco set
// used by the file tree's CodeMirrorFileView so the highlight palette
// the user sees in the editor matches what shows up in Read previews.
// Lowercase ext → Prism language id; unknown extensions fall through
// to plain text (no highlighting, but still renders safely).
const READ_LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', yaml: 'yaml', yml: 'yaml',
  json: 'json', toml: 'toml', xml: 'xml', html: 'markup', htm: 'markup', svg: 'markup',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  md: 'markdown', mdx: 'markdown', dockerfile: 'docker', prisma: 'prisma',
}

function langFromPath(path: string): string {
  if (!path) return 'text'
  const lower = path.toLowerCase()
  // Dockerfile / Makefile have no extension — match by basename.
  if (lower.endsWith('/dockerfile') || lower === 'dockerfile') return 'docker'
  if (lower.endsWith('/makefile') || lower === 'makefile') return 'makefile'
  const ext = lower.split('.').pop() ?? ''
  return READ_LANG_BY_EXT[ext] ?? 'text'
}

// ── Work block (groups consecutive tool messages) ───────────────────
//
// Mirrors the VSCode Claude Code layout: while Claude is working, the
// tool events show up in a fixed-height scrollable column — older rows
// scroll out of view as new ones arrive, the overall chat never grows
// unbounded. When the turn finishes the block collapses to a single
// summary row ("Thought for 12s · 5 steps") that expands on click.

function shortPath(p: string | undefined): string {
  if (!p) return ''
  // Strip the `.bornastar-worktrees/<id>/` prefix if present so paths
  // read like `src/foo.ts` instead of the full absolute path. When the
  // path IS exactly the worktree root (no path after the id), return
  // empty — callers use that as a signal to hide the location chip.
  const worktreeIdx = p.lastIndexOf('.bornastar-worktrees/')
  if (worktreeIdx >= 0) {
    const afterId = p.indexOf('/', worktreeIdx + '.bornastar-worktrees/'.length)
    if (afterId >= 0) return p.slice(afterId + 1)
    return ''
  }
  // Otherwise keep the last 3 segments at most — enough context, not noisy.
  const parts = p.split('/')
  if (parts.length > 3) return '…/' + parts.slice(-3).join('/')
  return p
}

// Like shortPath, but skips the 3-segment truncation — used by body
// rows of file-list blocks (Glob/LS results) that live inside a
// scrollable container, where preserving the full project-relative
// path is more useful than fitting on one line.
function relPath(p: string | undefined): string {
  if (!p) return ''
  const worktreeIdx = p.lastIndexOf('.bornastar-worktrees/')
  if (worktreeIdx >= 0) {
    const afterId = p.indexOf('/', worktreeIdx + '.bornastar-worktrees/'.length)
    if (afterId >= 0) return p.slice(afterId + 1)
    return ''
  }
  return p
}

function lineRangeFromInput(input?: Record<string, unknown>): string {
  if (!input) return ''
  const offset = input.offset as number | undefined
  const limit = input.limit as number | undefined
  if (typeof offset === 'number' && typeof limit === 'number') {
    return ` (lines ${offset}-${offset + limit})`
  }
  return ''
}

// Truncate a string to one line preview.
function preview(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

// ── Bash IN / OUT block ─────────────────────────────────────────────
// Always rendered inline under the bullet. Default shows a clipped
// preview (≈6 lines) so a noisy command doesn't blow up the chat
// height. An explicit expand button opens the full output without
// forcing an internal scrollbar — the block just grows.
function BashBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const output = typeof message.toolResult === 'string' ? message.toolResult : ''
  const outLines = output ? output.split('\n') : []
  const cmd = message.command ?? ''
  // Cap command (IN) and stdout (OUT) to 3 lines each by default. The
  // Show more / Collapse button below reveals or hides the rest — we
  // never add an internal scrollbar, the whole block grows.
  const PREVIEW_LINES = 3
  const cmdClamp = !expanded ? 'line-clamp-3' : ''
  const outClamp = !expanded ? 'line-clamp-3' : ''
  const outTruncated = !expanded && outLines.length > PREVIEW_LINES
  const cmdTruncated = !expanded && cmd.split('\n').length > PREVIEW_LINES
  const truncated = outTruncated || cmdTruncated
  const hidden = Math.max(0, outLines.length - PREVIEW_LINES)

  return (
    <div className="ml-3 mt-0.5 max-w-2xl overflow-hidden rounded border border-white/5 text-[11px] leading-5">
      <div className="flex border-b border-white/5 bg-white/[0.02] px-2 py-1">
        <span className="mr-2 font-mono text-[10px] uppercase tracking-wide text-zinc-500">IN</span>
        <span className={`min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-zinc-300 ${cmdClamp}`}>{cmd}</span>
      </div>
      <div className={`flex ${message.toolError ? 'border-l-2 border-red-500/50' : ''}`}>
        <span className="mx-2 mt-1 font-mono text-[10px] uppercase tracking-wide text-zinc-500">OUT</span>
        <pre className={`min-w-0 flex-1 whitespace-pre-wrap break-all py-1 pr-2 font-mono ${message.toolError ? 'text-red-300' : 'text-zinc-400'} ${outClamp}`}>
          {output || (message.toolResult === undefined ? '…' : '(empty)')}
        </pre>
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
        >
          Show {hidden > 0 ? `${hidden} more ${hidden === 1 ? 'line' : 'lines'}` : 'more'}
        </button>
      )}
      {expanded && (outLines.length > PREVIEW_LINES || cmd.split('\n').length > PREVIEW_LINES) && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── Read block (file path + content preview) ───────────────────────
// Header shows the file path and either "whole file · N lines" (when
// Claude read it all) or "lines X-Y" (when Claude scoped the read with
// offset+limit). Body strips the CLI's `   N→` line-number prefix and
// hands the raw code to react-syntax-highlighter so the preview reads
// with the same vivid palette the file tree uses — line numbers are
// reconstructed from the first parsed prefix as `startingLineNumber`.
//
// Visual style mirrors TodoBlock's inline card (border-white/5 + soft
// bg-white/[0.02]) so blocks feel like one consistent family across
// the chat, with the highlighted code itself supplying the only color.
function ReadBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const path = (message.toolInput?.file_path as string) ?? message.filePath ?? ''
  const offset = message.toolInput?.offset
  const limit = message.toolInput?.limit
  const isPartial = typeof offset === 'number' && typeof limit === 'number'
  const raw = typeof message.toolResult === 'string' ? message.toolResult : ''
  // Parse `   NNN→<content>`. Keep the cleaned content (fed to the
  // highlighter) and the first line number (used as the gutter's
  // starting offset). Lines without the prefix (error output, system
  // notes) pass through unchanged.
  const parsedLines = raw ? raw.split('\n').map((line) => {
    const m = /^(\s*)(\d+)→(.*)$/.exec(line)
    return m ? { num: parseInt(m[2], 10), text: m[3] } : { num: null as number | null, text: line }
  }) : []
  const totalLines = parsedLines.length
  const PREVIEW_LINES = totalLines > 200 ? 4 : 6
  const truncated = !expanded && totalLines > PREVIEW_LINES
  const hidden = Math.max(0, totalLines - PREVIEW_LINES)
  const visible = expanded ? parsedLines : parsedLines.slice(0, PREVIEW_LINES)
  const rangeLabel = isPartial ? `lines ${offset}-${(offset as number) + (limit as number)}` : 'whole file'
  const code = visible.map((r) => r.text).join('\n')
  // First numbered line in the preview becomes the starting gutter
  // value — matches what the user would see scrolling that file in
  // their editor instead of restarting at 1.
  const firstNum = visible.find((r) => r.num !== null)?.num ?? 1
  const language = langFromPath(path)

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="font-mono text-zinc-300">
          {shortPath(path) || 'file'}
          <span className="ml-2 text-zinc-500">· {rangeLabel}</span>
        </span>
        {totalLines > 0 && (
          <span className="font-mono text-[10px] text-zinc-500">{totalLines} {totalLines === 1 ? 'line' : 'lines'}</span>
        )}
      </div>
      <div className="max-h-64 overflow-auto">
        {visible.length === 0 ? (
          <div className="px-2 py-1 font-mono text-zinc-500">{message.toolResult === undefined ? '…' : '(empty)'}</div>
        ) : (
          <SyntaxHighlighter
            style={vscDarkPlus}
            language={language}
            PreTag="div"
            showLineNumbers
            startingLineNumber={firstNum}
            wrapLines
            wrapLongLines
            lineNumberStyle={{
              minWidth: '2.5rem',
              paddingRight: '0.75rem',
              textAlign: 'right',
              color: '#52525b',
              userSelect: 'none',
            }}
            customStyle={{
              margin: 0,
              padding: '6px 0',
              background: 'transparent',
              fontSize: '11px',
              lineHeight: '1.5',
            }}
            codeTagProps={{
              style: { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
            }}
          >
            {code}
          </SyntaxHighlighter>
        )}
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      )}
      {expanded && totalLines > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── Write block (new-file content preview) ─────────────────────────
// Write is a tool that creates/overwrites a file with `content`.
// Unlike Edit (a diff against the prior version), the whole payload is
// always brand new — so the right rendering is "here's the full code
// being written" rather than a +/- diff. Same shell as ReadBlock for
// visual consistency, syntax-highlighted body so the user can scan the
// new file in the same palette as the editor.
//
// Renders eagerly: `toolInput.content` is available the moment the
// tool_use event lands, before the result returns. So unlike ReadBlock
// (which needs the result to know what was read) we show the body
// immediately and just dim the header chip to "writing…" until the
// confirmation arrives.
function WriteBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const path = (message.toolInput?.file_path as string) ?? message.filePath ?? ''
  const content = (message.toolInput?.content as string) ?? ''
  const isLoading = message.toolResult === undefined
  const isError = message.toolError === true
  const lines = content ? content.split('\n') : []
  const totalLines = lines.length
  const PREVIEW_LINES = totalLines > 200 ? 4 : 6
  const truncated = !expanded && totalLines > PREVIEW_LINES
  const hidden = Math.max(0, totalLines - PREVIEW_LINES)
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES)
  const code = visible.join('\n')
  const language = langFromPath(path)
  // Status chip: pending while waiting for the tool_result, error
  // (red) if Write failed, otherwise emerald "+N lines" so the user
  // gets one clear signal that the file was created.
  const statusLabel = isError ? 'failed' : isLoading ? 'writing…' : `+${totalLines} ${totalLines === 1 ? 'line' : 'lines'}`
  const statusTone = isError ? 'text-red-400' : isLoading ? 'text-zinc-500' : 'text-emerald-400'

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="font-mono text-zinc-300">
          {shortPath(path) || 'file'}
          <span className="ml-2 text-zinc-500">· new file</span>
        </span>
        <span className={`font-mono text-[10px] ${statusTone}`}>{statusLabel}</span>
      </div>
      <div className="max-h-64 overflow-auto">
        {visible.length === 0 ? (
          <div className="px-2 py-1 font-mono text-zinc-500">(empty)</div>
        ) : (
          <SyntaxHighlighter
            style={vscDarkPlus}
            language={language}
            PreTag="div"
            showLineNumbers
            startingLineNumber={1}
            wrapLines
            wrapLongLines
            lineNumberStyle={{
              minWidth: '2.5rem',
              paddingRight: '0.75rem',
              textAlign: 'right',
              color: '#52525b',
              userSelect: 'none',
            }}
            customStyle={{
              margin: 0,
              padding: '6px 0',
              background: 'transparent',
              fontSize: '11px',
              lineHeight: '1.5',
            }}
            codeTagProps={{
              style: { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
            }}
          >
            {code}
          </SyntaxHighlighter>
        )}
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      )}
      {expanded && totalLines > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── Grep block (pattern + matches) ─────────────────────────────────
// Grep returns one of three text shapes depending on `output_mode`:
//   • files_with_matches (default) — one path per line, prefixed by
//     "Found N files" header line that ripgrep/the wrapper emits.
//   • content                       — `path:line:text` rows (or
//     `path-line-text` for context lines), separated by "--".
//   • count                         — `path:N` per file.
// We parse minimally — peel the "Found N…" header, render the rest as
// a list. Path + line number get a dim gutter so the matched text
// stays readable; the matched substring isn't highlighted (would
// require regex execution per row, and ripgrep's `--color` codes aren't
// in the result anyway). Same grey shell as ReadBlock/WriteBlock.
function GrepBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const pattern = (message.toolInput?.pattern as string) ?? message.searchPattern ?? ''
  const path = (message.toolInput?.path as string) ?? ''
  const glob = (message.toolInput?.glob as string) ?? ''
  const type = (message.toolInput?.type as string) ?? ''
  const outputMode = (message.toolInput?.output_mode as string) ?? 'files_with_matches'
  const isLoading = message.toolResult === undefined
  const isError = message.toolError === true
  const raw = typeof message.toolResult === 'string' ? message.toolResult : ''
  // Strip `<tool_use_error>...</tool_use_error>` wrapper the CLI emits
  // around tool failures — render the inner text plain so the user
  // sees a readable error instead of XML noise. Also strips the
  // worktree's absolute prefix from any embedded path so the error
  // reads `pasta/que/nao/existe` instead of the full
  // `/Users/.../bornastar-worktrees/wt-XXX/pasta/que/nao/existe`, and
  // drops the trailing "your current working directory is …" hint that
  // doubles the path noise.
  const errorText = isError
    ? raw
        .replace(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/, '$1')
        .replace(/\/Users\/[^/\s]+\/[^\s]*?\.bornastar-worktrees\/[^/\s]+\//g, '')
        .replace(/\s*Note: your current working directory is[\s\S]*$/i, '')
        .trim()
    : ''
  // Peel the leading "Found N files/matches" line if ripgrep's wrapper
  // emitted it — we render the count in the header chip instead.
  // Also detect the empty-result string ("No files found" / "No matches
  // found") so it's reported as 0, not as a 1-line result.
  const allLines = !isError && raw ? raw.split('\n').filter((l) => l.length > 0) : []
  const isEmptyResult = allLines.length === 1 && /^No (files|matches) found/i.test(allLines[0])
  const headerMatch = allLines[0]?.match(/^Found (\d+)/)
  const headerCount = isEmptyResult ? 0 : headerMatch ? parseInt(headerMatch[1], 10) : null
  const dataLines = isEmptyResult ? [] : headerMatch ? allLines.slice(1) : allLines
  const totalLines = dataLines.length
  const PREVIEW_LINES = totalLines > 40 ? 5 : 8
  const truncated = !expanded && totalLines > PREVIEW_LINES
  const hidden = Math.max(0, totalLines - PREVIEW_LINES)
  const visible = expanded ? dataLines : dataLines.slice(0, PREVIEW_LINES)

  // Filter chips shown next to the pattern: path / glob / type — only
  // when set, so simple "grep across repo" greps stay clean.
  const filters: string[] = []
  if (path) filters.push(shortPath(path))
  if (glob) filters.push(glob)
  if (type) filters.push(`type:${type}`)

  // Status chip: pending while running, error red on failure, dimmed
  // count when results are in. "0 results" is its own state — the user
  // probably wants to know the search ran AND came up empty.
  const statusLabel = isError ? 'failed'
    : isLoading ? 'searching…'
    : headerCount !== null ? `${headerCount} ${headerCount === 1 ? 'match' : 'matches'}`
    : totalLines === 0 ? 'no results'
    : `${totalLines} ${totalLines === 1 ? 'result' : 'results'}`
  const statusTone = isError ? 'text-red-400'
    : isLoading ? 'text-zinc-500'
    : (headerCount ?? totalLines) === 0 ? 'text-zinc-500'
    : 'text-emerald-400'

  // Renders one result line. For `content` mode we split off the
  // `path:N:` prefix into a dim gutter so the matched text reads
  // cleanly; for `files_with_matches` and `count` we render the raw
  // line as-is (already a path or path:N).
  const renderRow = (line: string, i: number) => {
    if (outputMode === 'content') {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line) ?? /^([^-]+)-(\d+)-(.*)$/.exec(line)
      if (m) {
        return (
          <div key={i} className="flex gap-2 px-2 py-0.5 font-mono">
            <span className="shrink-0 text-zinc-500">{shortPath(m[1])}<span className="text-zinc-600">:{m[2]}</span></span>
            <span className="min-w-0 flex-1 truncate text-zinc-300">{m[3]}</span>
          </div>
        )
      }
    }
    return (
      <div key={i} className="px-2 py-0.5 font-mono text-zinc-300">{line}</div>
    )
  }

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="min-w-0 truncate font-mono text-zinc-300">
          <span className="text-zinc-500">grep </span>
          <span className="text-amber-300">&quot;{pattern}&quot;</span>
          {filters.length > 0 && <span className="ml-2 text-zinc-500">in {filters.join(' · ')}</span>}
        </span>
        <span className={`shrink-0 font-mono text-[10px] ${statusTone}`}>{statusLabel}</span>
      </div>
      <div className="max-h-64 overflow-auto py-0.5">
        {isLoading ? (
          <div className="px-2 py-1 font-mono text-zinc-500">…</div>
        ) : isError ? (
          <div className="whitespace-pre-wrap px-2 py-1 font-mono text-red-300/90">{errorText || 'Tool error'}</div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-1 font-mono text-zinc-500">no matches</div>
        ) : (
          visible.map((line, i) => renderRow(line, i))
        )}
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show {hidden} more {hidden === 1 ? 'result' : 'results'}
        </button>
      )}
      {expanded && totalLines > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── File-list helpers ─────────────────────────────────────────────
// Splits a path into its dir prefix and the filename. Used by Glob/LS
// row rendering so the dim folder path and the bright filename can be
// styled separately — same visual contract the file tree uses.
function splitPath(p: string): { dir: string; name: string } {
  const idx = p.lastIndexOf('/')
  if (idx < 0) return { dir: '', name: p }
  return { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) }
}

// ── Glob block (pattern → list of files) ───────────────────────────
// Glob's result is a newline-separated list of paths sorted by mtime
// (recent first). We strip the worktree prefix the CLI emits, split
// each row into a dim folder prefix + brighter filename so the user
// can scan the list at a glance — same shell as ReadBlock/WriteBlock/
// GrepBlock for visual consistency.
function GlobBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const pattern = (message.toolInput?.pattern as string) ?? message.searchPattern ?? ''
  const path = (message.toolInput?.path as string) ?? ''
  const isLoading = message.toolResult === undefined
  const isError = message.toolError === true
  const raw = typeof message.toolResult === 'string' ? message.toolResult : ''
  const errorText = isError
    ? raw
        .replace(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/, '$1')
        .replace(/\/Users\/[^/\s]+\/[^\s]*?\.bornastar-worktrees\/[^/\s]+\//g, '')
        .replace(/\s*Note: your current working directory is[\s\S]*$/i, '')
        .trim()
    : ''
  // Glob emits a leading "Found N files" line + the filenames; or
  // "No files found" when empty.
  const allLines = !isError && raw ? raw.split('\n').filter((l) => l.length > 0) : []
  const isEmpty = allLines.length === 1 && /^No files found/i.test(allLines[0])
  const headerMatch = allLines[0]?.match(/^Found (\d+)/)
  const headerCount = isEmpty ? 0 : headerMatch ? parseInt(headerMatch[1], 10) : null
  const dataLines = isEmpty ? [] : headerMatch ? allLines.slice(1) : allLines
  const totalLines = dataLines.length
  const PREVIEW_LINES = totalLines > 40 ? 5 : 8
  const truncated = !expanded && totalLines > PREVIEW_LINES
  const hidden = Math.max(0, totalLines - PREVIEW_LINES)
  const visible = expanded ? dataLines : dataLines.slice(0, PREVIEW_LINES)

  const statusLabel = isError ? 'failed'
    : isLoading ? 'searching…'
    : (headerCount ?? totalLines) === 0 ? 'no files'
    : `${headerCount ?? totalLines} ${(headerCount ?? totalLines) === 1 ? 'file' : 'files'}`
  const statusTone = isError ? 'text-red-400'
    : isLoading ? 'text-zinc-500'
    : (headerCount ?? totalLines) === 0 ? 'text-zinc-500'
    : 'text-emerald-400'
  // Header location chip: hidden when path is empty OR resolves to the
  // worktree root after stripping (i.e. the search is across the whole
  // project anyway, no extra info to convey).
  const headerPath = shortPath(path)

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="min-w-0 truncate font-mono text-zinc-300">
          <span className="text-zinc-500">glob </span>
          <span className="text-amber-300">{pattern}</span>
          {headerPath && <span className="ml-2 text-zinc-500">in {headerPath}</span>}
        </span>
        <span className={`shrink-0 font-mono text-[10px] ${statusTone}`}>{statusLabel}</span>
      </div>
      <div className="max-h-64 overflow-auto py-0.5">
        {isLoading ? (
          <div className="px-2 py-1 font-mono text-zinc-500">…</div>
        ) : isError ? (
          <div className="whitespace-pre-wrap px-2 py-1 font-mono text-red-300/90">{errorText || 'Tool error'}</div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-1 font-mono text-zinc-500">no files</div>
        ) : (
          visible.map((line, i) => {
            const { dir, name } = splitPath(relPath(line))
            return (
              <div key={i} className="px-2 py-0.5 font-mono">
                {dir && <span className="text-zinc-500">{dir}</span>}
                <span className="text-zinc-200">{name}</span>
              </div>
            )
          })
        )}
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show {hidden} more {hidden === 1 ? 'file' : 'files'}
        </button>
      )}
      {expanded && totalLines > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── LS block (path → tree of files & folders) ─────────────────────
// LS's result is a pre-formatted indented tree:
//   - /abs/path/
//     - foo.ts
//     - sub/
//       - bar.ts
// We strip the leading "- " bullets, the colon-prefixed root, and the
// trailing "NOTE: …" advisory the CLI tacks on; render the rest in a
// monospace block, preserving indentation. Folders (lines ending in /)
// get a faint accent so the structure reads at a glance.
function LSBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const path = (message.toolInput?.path as string) ?? message.filePath ?? ''
  const isLoading = message.toolResult === undefined
  const isError = message.toolError === true
  const raw = typeof message.toolResult === 'string' ? message.toolResult : ''
  const errorText = isError
    ? raw
        .replace(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/, '$1')
        .replace(/\/Users\/[^/\s]+\/[^\s]*?\.bornastar-worktrees\/[^/\s]+\//g, '')
        .replace(/\s*Note: your current working directory is[\s\S]*$/i, '')
        .trim()
    : ''
  // The CLI's LS output sometimes ends with a long "NOTE: do not assume…"
  // advisory that's noise for the user — strip it.
  const cleaned = !isError ? raw.replace(/\n\s*NOTE: [\s\S]*$/i, '').trimEnd() : ''
  const allLines = cleaned ? cleaned.split('\n') : []
  // Drop the very first line if it's the absolute path of the root
  // (LS always emits this as a context header). Keep the rest of the
  // tree intact, including indentation.
  const dataLines = allLines.length && allLines[0].startsWith('-') && allLines[0].endsWith('/')
    ? allLines.slice(1)
    : allLines
  const totalLines = dataLines.length
  // Count entries (anything that's a non-empty row at any depth).
  const totalEntries = dataLines.filter((l) => l.trim().startsWith('-')).length
  const PREVIEW_LINES = totalLines > 40 ? 6 : 10
  const truncated = !expanded && totalLines > PREVIEW_LINES
  const hidden = Math.max(0, totalLines - PREVIEW_LINES)
  const visible = expanded ? dataLines : dataLines.slice(0, PREVIEW_LINES)

  const statusLabel = isError ? 'failed'
    : isLoading ? 'listing…'
    : totalEntries === 0 ? 'empty'
    : `${totalEntries} ${totalEntries === 1 ? 'entry' : 'entries'}`
  const statusTone = isError ? 'text-red-400'
    : isLoading ? 'text-zinc-500'
    : totalEntries === 0 ? 'text-zinc-500'
    : 'text-emerald-400'

  // Renders one tree row. Preserves the original indentation, replaces
  // the "- " bullet with a dot, and tints folder rows (trailing /) so
  // the tree's structure is readable without parsing it manually.
  const renderRow = (line: string, i: number) => {
    const m = /^(\s*)-\s(.*)$/.exec(line)
    if (!m) return <div key={i} className="px-2 py-0.5 font-mono text-zinc-300 whitespace-pre">{line}</div>
    const [, indent, body] = m
    const isFolder = body.endsWith('/')
    return (
      <div key={i} className="px-2 py-0.5 font-mono whitespace-pre">
        <span className="text-zinc-700">{indent}</span>
        <span className="text-zinc-600">· </span>
        <span className={isFolder ? 'text-amber-300' : 'text-zinc-200'}>{body}</span>
      </div>
    )
  }

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="min-w-0 truncate font-mono text-zinc-300">
          <span className="text-zinc-500">ls </span>
          <span className="text-amber-300">{shortPath(path) || '(project root)'}</span>
        </span>
        <span className={`shrink-0 font-mono text-[10px] ${statusTone}`}>{statusLabel}</span>
      </div>
      <div className="max-h-64 overflow-auto py-0.5">
        {isLoading ? (
          <div className="px-2 py-1 font-mono text-zinc-500">…</div>
        ) : isError ? (
          <div className="whitespace-pre-wrap px-2 py-1 font-mono text-red-300/90">{errorText || 'Tool error'}</div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-1 font-mono text-zinc-500">empty</div>
        ) : (
          visible.map((line, i) => renderRow(line, i))
        )}
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show {hidden} more {hidden === 1 ? 'row' : 'rows'}
        </button>
      )}
      {expanded && totalLines > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── WebFetch block (URL + prompt + content preview) ───────────────
// WebFetch's input has `url` (the page) and `prompt` (what Claude was
// looking for in it); the result is the extracted text. Render as the
// same grey card the other blocks use, with a clickable URL header,
// the fetch prompt as italic context, and a dim preview of the
// extracted text. The full body opens in a scroll container on expand.
function WebFetchBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const url = (message.toolInput?.url as string) ?? ''
  const prompt = (message.toolInput?.prompt as string) ?? ''
  const isLoading = message.toolResult === undefined
  const isError = message.toolError === true
  const raw = typeof message.toolResult === 'string' ? message.toolResult : ''
  const errorText = isError
    ? raw.replace(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/, '$1').trim()
    : ''
  const lines = !isError && raw ? raw.split('\n') : []
  const totalLines = lines.length
  const PREVIEW_LINES = totalLines > 100 ? 4 : 8
  const truncated = !expanded && totalLines > PREVIEW_LINES
  const hidden = Math.max(0, totalLines - PREVIEW_LINES)
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES)

  // Display host instead of full URL when the URL is long — keeps the
  // header readable even for query-heavy URLs (?utm=…&ref=…). The full
  // URL is still the link target.
  let displayUrl = url
  try {
    const u = new URL(url)
    displayUrl = u.host + u.pathname.replace(/\/$/, '')
    if (u.search && displayUrl.length < 50) displayUrl += u.search
  } catch { /* not a parseable URL — show raw */ }
  if (displayUrl.length > 70) displayUrl = displayUrl.slice(0, 70) + '…'

  const statusLabel = isError ? 'failed' : isLoading ? 'fetching…' : 'done'
  const statusTone = isError ? 'text-red-400' : isLoading ? 'text-zinc-500' : 'text-emerald-400'

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="min-w-0 truncate font-mono text-zinc-300">
          <span className="text-zinc-500">fetch </span>
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className="text-amber-300 hover:underline">{displayUrl}</a>
          ) : (
            <span className="text-amber-300">(no url)</span>
          )}
        </span>
        <span className={`shrink-0 font-mono text-[10px] ${statusTone}`}>{statusLabel}</span>
      </div>
      {prompt && (
        <div className="border-b border-white/5 px-2 py-1 text-[10px] italic text-zinc-500">
          looking for: {prompt}
        </div>
      )}
      <div className="max-h-64 overflow-auto py-0.5">
        {isLoading ? (
          <div className="px-2 py-1 font-mono text-zinc-500">…</div>
        ) : isError ? (
          <div className="whitespace-pre-wrap px-2 py-1 font-mono text-red-300/90">{errorText || 'Tool error'}</div>
        ) : visible.length === 0 ? (
          <div className="px-2 py-1 font-mono text-zinc-500">(empty)</div>
        ) : (
          <div className="whitespace-pre-wrap px-2 py-1 text-zinc-300">{visible.join('\n')}</div>
        )}
      </div>
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show {hidden} more {hidden === 1 ? 'line' : 'lines'}
        </button>
      )}
      {expanded && totalLines > PREVIEW_LINES && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── WebSearch block (query + result list) ─────────────────────────
// WebSearch's result is a free-form text block emitted by the CLI's
// search wrapper — usually one paragraph of intro + a list of links.
// We try to extract structured rows by detecting `Title (url)` or
// markdown-style `[Title](url)` patterns; anything that doesn't match
// renders as raw paragraph text. Same grey shell, query in amber to
// match the other "search-shaped" blocks (Grep/Glob).
function WebSearchBlock({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const query = (message.toolInput?.query as string) ?? message.searchPattern ?? ''
  const isLoading = message.toolResult === undefined
  const isError = message.toolError === true
  const raw = typeof message.toolResult === 'string' ? message.toolResult : ''
  const errorText = isError
    ? raw.replace(/^<tool_use_error>([\s\S]*?)<\/tool_use_error>$/, '$1').trim()
    : ''
  // Extract result entries. The CLI's primary shape is a JSON-tagged
  // dump:
  //   `Web search results for query: "..."` (header)
  //   `Links: [{"title":"…","url":"…"}, …]`  (array of hits)
  // We grab the bracketed JSON after `Links:` and parse it. Falls back
  // to markdown / plain `Title (url)` shapes for older responses, then
  // to raw text rendering if nothing structured is detected.
  type SearchHit = { title: string; url: string }
  const hits: SearchHit[] = []
  if (!isError && raw) {
    // Primary: JSON array after `Links:`. Use a non-greedy match up to
    // the closing bracket — handles trailing prose after the array.
    const jsonMatch = /Links:\s*(\[[\s\S]*?\])(?:\s*(?:\n|$))/.exec(raw)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1]) as unknown
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (entry && typeof entry === 'object' && 'title' in entry && 'url' in entry) {
              const title = String((entry as { title: unknown }).title ?? '').trim()
              const url = String((entry as { url: unknown }).url ?? '').trim()
              if (title && url) hits.push({ title, url })
            }
          }
        }
      } catch { /* malformed JSON — fall through */ }
    }
    // Fallback: line-by-line markdown / plain shapes.
    if (hits.length === 0) {
      const lineRe = /^\s*(?:[-*]\s+)?(?:\[(.+?)\]\((https?:\/\/[^)]+)\)|(.+?)\s+\((https?:\/\/[^)]+)\))\s*$/gm
      let m: RegExpExecArray | null
      while ((m = lineRe.exec(raw)) !== null) {
        const title = (m[1] ?? m[3] ?? '').trim()
        const url = (m[2] ?? m[4] ?? '').trim()
        if (title && url) hits.push({ title, url })
      }
    }
  }
  const hasHits = hits.length > 0
  const totalHits = hits.length
  const PREVIEW_HITS = 5
  const truncated = !expanded && totalHits > PREVIEW_HITS
  const hidden = Math.max(0, totalHits - PREVIEW_HITS)
  const visibleHits = expanded ? hits : hits.slice(0, PREVIEW_HITS)
  // For non-structured fallback, paginate by lines.
  const rawLines = !isError && raw ? raw.split('\n') : []
  const PREVIEW_LINES = rawLines.length > 100 ? 4 : 8
  const visibleLines = expanded ? rawLines : rawLines.slice(0, PREVIEW_LINES)
  const truncatedLines = !expanded && rawLines.length > PREVIEW_LINES
  const hiddenLines = Math.max(0, rawLines.length - PREVIEW_LINES)

  const statusLabel = isError ? 'failed'
    : isLoading ? 'searching…'
    : hasHits ? `${totalHits} ${totalHits === 1 ? 'result' : 'results'}`
    : 'done'
  const statusTone = isError ? 'text-red-400'
    : isLoading ? 'text-zinc-500'
    : hasHits ? 'text-emerald-400'
    : 'text-zinc-500'

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between gap-2 border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="min-w-0 truncate font-mono text-zinc-300">
          <span className="text-zinc-500">search </span>
          <span className="text-amber-300">&quot;{query}&quot;</span>
        </span>
        <span className={`shrink-0 font-mono text-[10px] ${statusTone}`}>{statusLabel}</span>
      </div>
      <div className="max-h-64 overflow-auto py-0.5">
        {isLoading ? (
          <div className="px-2 py-1 font-mono text-zinc-500">…</div>
        ) : isError ? (
          <div className="whitespace-pre-wrap px-2 py-1 font-mono text-red-300/90">{errorText || 'Tool error'}</div>
        ) : hasHits ? (
          visibleHits.map((hit, i) => {
            let host = ''
            try { host = new URL(hit.url).host } catch { host = hit.url }
            return (
              <a
                key={i}
                href={hit.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block border-b border-white/5 px-2 py-1 transition-colors last:border-b-0 hover:bg-white/[0.03]"
              >
                <div className="truncate text-zinc-200">{hit.title}</div>
                <div className="truncate font-mono text-[10px] text-zinc-500">{host}</div>
              </a>
            )
          })
        ) : visibleLines.length === 0 ? (
          <div className="px-2 py-1 font-mono text-zinc-500">(empty)</div>
        ) : (
          <div className="whitespace-pre-wrap px-2 py-1 text-zinc-300">{visibleLines.join('\n')}</div>
        )}
      </div>
      {(hasHits ? truncated : truncatedLines) && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          {hasHits
            ? `Show ${hidden} more ${hidden === 1 ? 'result' : 'results'}`
            : `Show ${hiddenLines} more ${hiddenLines === 1 ? 'line' : 'lines'}`}
        </button>
      )}
      {expanded && (hasHits ? totalHits > PREVIEW_HITS : rawLines.length > PREVIEW_LINES) && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="w-full border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Collapse
        </button>
      )}
    </div>
  )
}

// ── Edit diff block (per-operation, syntax-highlighted) ───────────
// Renders the edit operations Claude performed on a file. For Edit
// (single op) there's one entry; for MultiEdit the toolInput's `edits`
// array is unpacked into N entries, one per operation. Each operation
// becomes its own visual block inside the card:
//
//   • pure add    (old_string empty)  → green segment with the new code
//   • pure remove (new_string empty)  → red segment with the removed code
//   • replace     (both non-empty)    → red segment + green segment stacked
//
// Each operation block has a fixed preview height (PREVIEW_LINES per
// segment); when the change is bigger, a chevron at the bottom of the
// op expands the whole op (both red and green together). Code in each
// segment runs through SyntaxHighlighter (vscDarkPlus) so colors match
// what the user sees in the file tree.
type EditOp = { oldStr: string; newStr: string }
// Total visible-line budget per operation when collapsed. Distributed
// across the red+green segments so no single operation grows beyond
// this height — anything bigger gets the expand chevron and reveals
// every line on click. No internal scroll: pure full-expand/collapse.
const EDIT_PREVIEW_TOTAL = 8

// Strips the trailing newline diffLines tends to leave so the line
// count + the rendered preview don't double-count an empty last line.
function trimTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s.slice(0, -1) : s
}

// Renders one operation. Self-contained collapse/expand state — each
// op manages its own visibility independently of siblings, matching
// the ReadBlock/WriteBlock pattern.
function EditOpBlock({ op, language }: { op: EditOp; language: string }) {
  const [expanded, setExpanded] = useState(false)
  const oldStr = trimTrailingNewline(op.oldStr)
  const newStr = trimTrailingNewline(op.newStr)
  const oldLines = oldStr ? oldStr.split('\n') : []
  const newLines = newStr ? newStr.split('\n') : []
  const oldTotal = oldLines.length
  const newTotal = newLines.length

  // Budget allocation for the collapsed view. When one side is empty
  // the other gets the full cap; when both have content, give each
  // side its full size if the combined fits, otherwise split. If one
  // side fits in half the budget the leftover spills to the bigger
  // side (matches Cursor's behavior — small remove + big add stays
  // useful, with the add showing more context).
  let oldShown = oldTotal
  let newShown = newTotal
  if (oldTotal + newTotal > EDIT_PREVIEW_TOTAL) {
    if (oldTotal === 0) {
      newShown = EDIT_PREVIEW_TOTAL
    } else if (newTotal === 0) {
      oldShown = EDIT_PREVIEW_TOTAL
    } else {
      const half = Math.floor(EDIT_PREVIEW_TOTAL / 2)
      if (oldTotal <= half) {
        oldShown = oldTotal
        newShown = EDIT_PREVIEW_TOTAL - oldShown
      } else if (newTotal <= half) {
        newShown = newTotal
        oldShown = EDIT_PREVIEW_TOTAL - newShown
      } else {
        oldShown = half
        newShown = EDIT_PREVIEW_TOTAL - half
      }
    }
  }
  const hasOverflow = oldShown < oldTotal || newShown < newTotal
  const visibleOld = expanded ? oldLines : oldLines.slice(0, oldShown)
  const visibleNew = expanded ? newLines : newLines.slice(0, newShown)
  const hiddenOld = oldTotal - oldShown
  const hiddenNew = newTotal - newShown

  const renderSegment = (lines: string[], kind: 'add' | 'remove') => {
    // Tint matches Cursor's diff style — saturated enough that the
    // user sees red/green at a glance, light enough that the syntax
    // highlight on top stays readable. No label bar above the code:
    // the color IS the indicator, and the +/- counts already show in
    // the card's header chip.
    const tint = kind === 'add' ? 'bg-emerald-500/[0.10]' : 'bg-red-500/[0.10]'
    return (
      <div className={`overflow-hidden ${tint}`}>
        <SyntaxHighlighter
          style={vscDarkPlus}
          language={language}
          PreTag="div"
          wrapLongLines
          customStyle={{
            margin: 0,
            padding: '4px 8px',
            background: 'transparent',
            fontSize: '11px',
            lineHeight: '1.5',
          }}
          codeTagProps={{
            style: { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
          }}
        >
          {lines.join('\n')}
        </SyntaxHighlighter>
      </div>
    )
  }

  return (
    <div>
      {oldTotal > 0 && renderSegment(visibleOld, 'remove')}
      {newTotal > 0 && renderSegment(visibleNew, 'add')}
      {hasOverflow && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center justify-center gap-1 border-t border-white/5 bg-white/[0.02] py-1 text-[10px] text-zinc-400 transition-colors hover:bg-white/[0.04] hover:text-zinc-200"
        >
          {expanded ? (
            <>
              <span>Collapse</span>
              <span aria-hidden>▲</span>
            </>
          ) : (
            <>
              <span>
                Show {hiddenOld + hiddenNew} more {hiddenOld + hiddenNew === 1 ? 'line' : 'lines'}
              </span>
              <span aria-hidden>▼</span>
            </>
          )}
        </button>
      )}
    </div>
  )
}

function EditDiffBlock({ message }: { message: ChatMessage }) {
  const ops: EditOp[] = []
  // MultiEdit: toolInput.edits is the array of operations.
  const rawEdits = (message.toolInput as { edits?: unknown } | undefined)?.edits
  if (Array.isArray(rawEdits)) {
    for (const e of rawEdits) {
      if (e && typeof e === 'object') {
        const oldStr = String((e as { old_string?: unknown }).old_string ?? '')
        const newStr = String((e as { new_string?: unknown }).new_string ?? '')
        if (oldStr || newStr) ops.push({ oldStr, newStr })
      }
    }
  } else {
    // Edit (single): the message's top-level old/new strings.
    const oldStr = message.oldString ?? ''
    const newStr = message.newString ?? ''
    if (oldStr || newStr) ops.push({ oldStr, newStr })
  }

  // Header chip: total +/- across every operation, so a 5-edit
  // MultiEdit reads at a glance as one rolled-up summary.
  let totalAdded = 0
  let totalRemoved = 0
  for (const { oldStr, newStr } of ops) {
    const o = trimTrailingNewline(oldStr)
    const n = trimTrailingNewline(newStr)
    if (n) totalAdded += n.split('\n').length
    if (o) totalRemoved += o.split('\n').length
  }
  const language = langFromPath(message.filePath ?? '')

  return (
    <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 bg-white/[0.02] text-[11px] leading-5">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px]">
        <span className="font-mono text-zinc-300">
          {message.filePath ? shortPath(message.filePath) : 'Edit'}
          {ops.length > 1 && <span className="ml-2 text-zinc-500">· {ops.length} edits</span>}
        </span>
        <span className="font-mono">
          {totalAdded > 0 && <span className="text-emerald-400">+{totalAdded}</span>}
          {totalAdded > 0 && totalRemoved > 0 && <span className="text-zinc-600"> </span>}
          {totalRemoved > 0 && <span className="text-red-400">-{totalRemoved}</span>}
        </span>
      </div>
      {ops.length === 0 ? (
        <div className="px-2 py-1 font-mono text-zinc-500">(no changes)</div>
      ) : (
        ops.map((op, i) => (
          <div key={i} className="border-b border-white/5 last:border-b-0">
            <EditOpBlock op={op} language={language} />
          </div>
        ))
      )}
    </div>
  )
}

// ── Todo block (Claude Code-style checklist) ───────────────────────
// TodoWrite's toolInput.todos is an array of { content, activeForm, status }.
// We render it as a checklist matching how Claude Code's CLI / VSCode
// extension renders it, so the user sees the actual plan instead of a
// generic "Tasks" bullet that hides behind a JSON dump.
//
// Status mapping:
//   pending     → ☐ + zinc text
//   in_progress → ◐ + amber text + uses `activeForm` (e.g. "Running tests")
//   completed   → ☑ + emerald text + strikethrough
//
// Defensive on shape: if `todos` is missing or malformed (schema drift,
// stale buffered row from before this block existed) the block returns
// null and the parent's generic JSON-expand fallback takes over. No
// throw, no broken row.
type TodoStatus = 'pending' | 'in_progress' | 'completed'
interface TodoItem {
  content?: string
  activeForm?: string
  status?: TodoStatus
}

// `variant`:
//   • 'inline'  — buried inside a CompactToolRow's expansion; full list
//     always visible, with left margin aligning it under the bullet.
//     Used when the user has manually expanded a "Thought for Xs" log.
//   • 'pinned'  — sits OUTSIDE the work block as the turn's "current
//     plan". Renders Cursor-style: a single compact header line by
//     default ("◐ <current task>  3/5  ▼") that always stays visible,
//     click toggles the full checklist below. Stays even after the
//     work block collapses, so the user can always see where Claude is.
export function TodoBlock({ message, variant = 'inline', active = false }: { message: ChatMessage; variant?: 'inline' | 'pinned'; active?: boolean }) {
  // Pinned card expansion: tracks an explicit user override (null = "no
  // override, follow the default"). Default is `!active` — open while
  // showing the plan or the final result, closed while Claude is mid-
  // execution to keep the chat compact. Once the user clicks to toggle,
  // their choice sticks even across the active→idle transition.
  const [userOverride, setUserOverride] = useState<boolean | null>(null)
  const input = message.toolInput as { todos?: unknown } | undefined
  const todos = Array.isArray(input?.todos) ? (input.todos as TodoItem[]) : null
  if (!todos || todos.length === 0) return null

  const counts = { pending: 0, in_progress: 0, completed: 0 }
  for (const t of todos) {
    if (t.status === 'in_progress') counts.in_progress++
    else if (t.status === 'completed') counts.completed++
    else counts.pending++
  }

  // Renders one row of the checklist. Used by both variants — same
  // visual contract regardless of where the list shows up.
  const renderRow = (todo: TodoItem, i: number, big: boolean) => {
    const status: TodoStatus = todo.status ?? 'pending'
    // While in_progress show `activeForm` ("Running tests") which reads
    // as live narration; otherwise the imperative `content` ("Run
    // tests") which reads like a checklist item.
    const text = status === 'in_progress' ? (todo.activeForm || todo.content || '') : (todo.content || '')
    const icon = status === 'completed' ? '☑' : status === 'in_progress' ? '◐' : '☐'
    const tone =
      status === 'completed' ? 'text-emerald-400 line-through opacity-70'
      : status === 'in_progress' ? 'text-amber-300'
      : 'text-zinc-400'
    const iconCls = big
      ? 'mt-[1px] shrink-0 font-mono text-[15px] leading-5'
      : 'mt-[1px] shrink-0 font-mono'
    const rowCls = big
      ? 'flex items-start gap-2 px-1 py-0.5'
      : 'flex items-start gap-2 px-2 py-0.5'
    return (
      <div key={i} className={rowCls}>
        <span className={`${iconCls} ${tone}`}>{icon}</span>
        <span className={`min-w-0 flex-1 ${tone}`}>{text}</span>
      </div>
    )
  }

  // ── Inline variant — full list, framed, used inside the log ────
  if (variant === 'inline') {
    return (
      <div className="ml-3 mt-0.5 overflow-hidden rounded border border-white/5 text-[11px] leading-5">
        <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-2 py-1 text-[10px] text-zinc-500">
          <span className="font-medium">Tasks</span>
          <span className="space-x-2 font-mono">
            {counts.completed > 0 && <span className="text-emerald-400">{counts.completed} done</span>}
            {counts.in_progress > 0 && <span className="text-amber-400">{counts.in_progress} active</span>}
            {counts.pending > 0 && <span className="text-zinc-500">{counts.pending} pending</span>}
          </span>
        </div>
        <div className="max-h-64 overflow-auto py-1">
          {todos.map((todo, i) => renderRow(todo, i, false))}
        </div>
      </div>
    )
  }

  // ── Pinned variant — single card, dynamic default expansion ────
  //
  // Always wrapped in the same translucent card so the visual identity
  // doesn't shift when Claude transitions from planning → executing →
  // done. What CHANGES is whether the body is expanded by default:
  //
  //   • Active (mid-execution)    → header collapsed by default, just
  //                                 a single live line "◐ <current task>
  //                                 3/5". Logs above are already noisy;
  //                                 the compact header keeps the chat
  //                                 column readable while still showing
  //                                 progress at a glance.
  //   • Idle (plan or finished)   → body open by default. The list IS
  //                                 the takeaway at this point — no
  //                                 reason to hide it behind a click.
  //
  // The user can always toggle. `userOverride` (null = follow default,
  // bool = explicit user choice) makes their click sticky even when
  // active flips false at end of turn.
  const expanded = userOverride !== null ? userOverride : !active

  // "Current step" is whichever task is actively being worked on. If
  // none is in_progress (between updates / not yet started) we fall
  // back to the first pending; if nothing is pending we use the last
  // completed (terminal "all done" state). Used by the compact header
  // when active=true to show what Claude is actually on.
  let currentIdx = todos.findIndex((t) => t.status === 'in_progress')
  if (currentIdx === -1) currentIdx = todos.findIndex((t) => (t.status ?? 'pending') !== 'completed')
  if (currentIdx === -1) currentIdx = todos.length - 1
  const currentTask = todos[currentIdx]
  const currentStatus: TodoStatus = currentTask.status ?? 'pending'
  const currentText = currentStatus === 'in_progress'
    ? (currentTask.activeForm || currentTask.content || '')
    : (currentTask.content || '')
  const currentIcon = currentStatus === 'completed' ? '☑' : currentStatus === 'in_progress' ? '◐' : '☐'
  const currentTone =
    currentStatus === 'completed' ? 'text-emerald-400'
    : currentStatus === 'in_progress' ? 'text-amber-300'
    : 'text-zinc-300'
  const allDone = counts.completed === todos.length

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-white/10 bg-white/[0.03] text-[11px] leading-5 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => setUserOverride(!expanded)}
        className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
      >
        {active ? (
          // Active header — current step icon + activeForm + N/total
          <>
            <span className={`shrink-0 font-mono text-[15px] leading-5 ${currentTone}`}>{currentIcon}</span>
            <span className={`min-w-0 flex-1 truncate ${currentTone}`}>
              {currentText}
            </span>
            <span className={`shrink-0 font-mono text-[10px] ${allDone ? 'text-emerald-400' : 'text-zinc-500'}`}>
              {currentIdx + 1}/{todos.length}
            </span>
          </>
        ) : (
          // Idle header — "Tasks" label + count breakdown. Cleaner than
          // showing a single task because the body below already shows
          // every task with its status.
          <>
            <span className="font-medium text-zinc-200">Tasks</span>
            <span className="min-w-0 flex-1 space-x-2 font-mono text-[10px]">
              {counts.completed > 0 && <span className="text-emerald-400">{counts.completed} done</span>}
              {counts.in_progress > 0 && <span className="text-amber-400">{counts.in_progress} active</span>}
              {counts.pending > 0 && <span className="text-zinc-500">{counts.pending} pending</span>}
            </span>
          </>
        )}
        <svg
          className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform group-hover:text-zinc-400 ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {expanded && (
        <div className="max-h-64 overflow-auto border-t border-white/5 px-1.5 py-1">
          {todos.map((todo, i) => renderRow(todo, i, true))}
        </div>
      )}
    </div>
  )
}

// ── Todo transition row ────────────────────────────────────────────
// Inside the log we don't repeat the full checklist (the pinned widget
// already does that, live). Instead each TodoWrite call shows up as a
// single transition line: "[just-completed task] → [now-active task]".
// First call shows just the starting task; final call shows just the
// last completed. Keeps the log compact and useful — the user sees the
// progress milestones in chronological order without scrolling past
// 5 identical-looking checklists.
function TodoTransitionRow({ message }: { message: ChatMessage }) {
  const input = message.toolInput as { todos?: unknown } | undefined
  const todos = Array.isArray(input?.todos) ? (input.todos as TodoItem[]) : null
  if (!todos || todos.length === 0) return null
  // The "just-completed" milestone is the LAST completed task in the
  // array (Claude updates them in order, so the deepest completed is
  // what changed most recently). "Active" is the in_progress task; if
  // none, fall back to the first pending so the row still shows what's
  // queued next. When everything is completed and nothing is pending
  // we surface the terminal state explicitly.
  let lastCompleted: TodoItem | null = null
  for (const t of todos) if (t.status === 'completed') lastCompleted = t
  const inProgress = todos.find((t) => t.status === 'in_progress') ?? null
  const nextPending = inProgress ? null : (todos.find((t) => (t.status ?? 'pending') === 'pending') ?? null)
  const allDone = !inProgress && !nextPending && !!lastCompleted

  return (
    <div className="relative flex items-start py-0.5 pl-4 pr-1 text-[12px] leading-5">
      <span className="pointer-events-none absolute left-[-15px] top-[9px] h-1.5 w-1.5 rounded-full bg-zinc-500 ring-2 ring-zinc-950" />
      <span className="min-w-0 flex-1">
        {lastCompleted && (
          <>
            <span className="font-mono text-emerald-400">☑</span>
            <span className="ml-1.5 text-zinc-400 line-through opacity-70">{lastCompleted.content}</span>
          </>
        )}
        {lastCompleted && (inProgress || nextPending) && <span className="mx-2 text-zinc-600">→</span>}
        {inProgress && (
          <>
            <span className="font-mono text-amber-400">◐</span>
            <span className="ml-1.5 text-amber-300">{inProgress.activeForm || inProgress.content}</span>
          </>
        )}
        {!inProgress && nextPending && (
          <>
            <span className="font-mono text-zinc-500">☐</span>
            <span className="ml-1.5 text-zinc-400">{nextPending.content}</span>
          </>
        )}
        {allDone && (
          <span className="ml-1.5 text-emerald-400 italic">All tasks done</span>
        )}
      </span>
    </div>
  )
}

// One compact line per item — bullet + label + preview. Handles tool,
// thinking and intermediate assistant text rows inside the work block.
function CompactToolRow({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)

  // TodoWrite gets a custom one-liner showing the transition (just-
  // completed → now-active). The pinned widget outside the work block
  // already renders the full checklist live, so a plain "Tasks" bullet
  // here would be redundant noise. Early-return AFTER useState so the
  // hook order stays consistent across renders even if the row ever
  // had its toolName mutated (defensive — it doesn't today).
  if (message.toolName === 'TodoWrite') {
    return <TodoTransitionRow message={message} />
  }

  // Thinking / intermediate assistant text — single-line preview,
  // click expands to the full text in italics.
  if (message.role === 'thinking' || message.role === 'assistant') {
    const isThinking = message.role === 'thinking'
    const text = message.content ?? ''
    return (
      <div className="group relative">
        <span aria-hidden className="pointer-events-none absolute left-[-15px] top-[9px] h-1.5 w-1.5 rounded-full bg-zinc-500 ring-2 ring-zinc-950" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start py-0.5 pl-4 pr-1 text-left text-[12px] leading-5 transition-colors hover:bg-white/5"
        >
          <span className="min-w-0 flex-1">
            {isThinking && <span className="font-medium text-zinc-300">Thinking</span>}
            {isThinking && <span className="mx-1.5 text-zinc-600">·</span>}
            <span className={`text-zinc-500 ${isThinking ? 'italic' : ''}`}>{preview(text)}</span>
          </span>
        </button>
        {expanded && (
          <div className={`ml-3 mt-0.5 whitespace-pre-wrap rounded border border-white/5 bg-black/30 px-2 py-1.5 text-[11px] leading-5 ${isThinking ? 'italic text-zinc-400' : 'text-zinc-300'}`}>
            {text}
          </div>
        )}
      </div>
    )
  }

  // Tool row — bullet + label + filename/command + status dot.
  const label = TOOL_CONFIG[message.toolName ?? '']?.label ?? message.toolName ?? 'Tool'
  const isLoading = message.toolResult === undefined
  const isError = message.toolError
  const hasResult = !isLoading
  const detail = message.filePath
    ? `${shortPath(message.filePath)}${lineRangeFromInput(message.toolInput)}`
    : message.command
      ? message.command.length > 70 ? message.command.slice(0, 70) + '…' : message.command
      : message.searchPattern
        ? `"${message.searchPattern}"`
        : ''

  // Bash, Edit, TodoWrite, Read and Write get rich inline blocks —
  // always visible, no click. Matches Claude Code's CLI/VSCode
  // extension rendering so the user sees plans, diffs, command output
  // and file contents without having to expand a generic JSON dump.
  // Anything not on this list still falls through to that JSON
  // fallback below.
  const isBash = message.toolName === 'Bash'
  const isEdit = message.toolName === 'Edit' || message.toolName === 'MultiEdit'
  const isTodoWrite = message.toolName === 'TodoWrite'
  const isRead = message.toolName === 'Read'
  const isWrite = message.toolName === 'Write'
  const isGrep = message.toolName === 'Grep'
  const isGlob = message.toolName === 'Glob'
  const isLs = message.toolName === 'LS'
  const isWebFetch = message.toolName === 'WebFetch'
  const isWebSearch = message.toolName === 'WebSearch'
  const inlineBlock = isBash
    ? hasResult || isLoading ? <BashBlock message={message} /> : null
    : isEdit
      ? <EditDiffBlock message={message} />
      : isTodoWrite
        ? <TodoBlock message={message} />
        : isRead && hasResult
          ? <ReadBlock message={message} />
          : isWrite
            ? <WriteBlock message={message} />
            : isGrep
              ? <GrepBlock message={message} />
              : isGlob
                ? <GlobBlock message={message} />
                : isLs
                  ? <LSBlock message={message} />
                  : isWebFetch
                    ? <WebFetchBlock message={message} />
                    : isWebSearch
                      ? <WebSearchBlock message={message} />
                      : null

  return (
    <div className="group relative">
      <span
        aria-hidden
        className={`pointer-events-none absolute left-[-15px] top-[9px] h-1.5 w-1.5 rounded-full ring-2 ring-zinc-950 ${
          isError ? 'bg-red-400'
          : isLoading ? 'bg-amber-400 animate-pulse'
          : 'bg-zinc-500'
        }`}
      />
      <button
        type="button"
        onClick={() => !inlineBlock && hasResult && setExpanded((v) => !v)}
        className="flex w-full items-start py-0.5 pl-4 pr-1 text-left text-[12px] leading-5 transition-colors hover:bg-white/5"
      >
        <span className="min-w-0 flex-1">
          <span className="font-medium text-zinc-300">{label}</span>
          {detail && !isBash && (
            <span className="ml-1.5 font-mono text-zinc-500">{detail}</span>
          )}
        </span>
      </button>
      {/* Rich inline block for Bash / Edit — always open, compact. */}
      {inlineBlock}
      {/* Generic click-to-expand for other tools. */}
      {!inlineBlock && expanded && hasResult && (
        <div className="ml-4 mt-0.5 max-h-64 overflow-auto rounded border border-white/5 bg-black/30 px-2 py-1.5 font-mono text-[11px] text-zinc-400">
          {typeof message.toolResult === 'string' ? (
            <pre className="whitespace-pre-wrap">{message.toolResult}</pre>
          ) : (
            <pre className="whitespace-pre-wrap">{JSON.stringify(message.toolResult, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  )
}

// A run of consecutive tool messages.
//   active = still streaming → stays expanded (mandatory), scroll
//            glued to the newest row so new steps appear at the
//            bottom in real time.
//   !active = turn finished → collapses automatically to keep the
//            chat flow tidy. User can click the header to re-expand
//            if they want to review the steps.
export function WorkBlock({
  messages,
  active,
  durationMs,
}: {
  messages: ChatMessage[]
  active: boolean
  durationMs?: number
}) {
  const [expanded, setExpanded] = useState(active)

  // Follow `active`: open when streaming starts, close when it ends.
  // useLayoutEffect (not useEffect) so the sync to `active` happens
  // BEFORE the browser paints — without it there's a one-frame gap
  // where the "Thought for Xs" header and the still-expanded list
  // both render at once, which read as a "blink" right when the turn
  // finishes and the pinned TodoBlock below is also re-flowing. With
  // useLayoutEffect the user only ever sees the final, settled state.
  useLayoutEffect(() => {
    setExpanded(active)
  }, [active])

  if (messages.length === 0) return null

  const durationSec = typeof durationMs === 'number'
    ? (durationMs / 1000).toFixed(1)
    : (() => {
        const first = messages[0].timestamp
        const last = messages[messages.length - 1].timestamp
        return ((last - first) / 1000).toFixed(1)
      })()

  return (
    <div className="my-1">
      {/* Summary row ONLY renders once the turn finishes, as a subtle
          "Thought for Xs" affordance that collapses the log. While
          active we skip the header entirely — logs speak for
          themselves and the amber-dot spinner already lives in the
          parent chat header. Keeps the stream feeling like real logs,
          not a framed widget. */}
      {!active && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="group flex w-full cursor-pointer items-center gap-2 py-0.5 text-left text-[11px] text-zinc-500 transition-colors hover:text-zinc-200"
        >
          <span className="flex-1 font-medium">{`Thought for ${durationSec}s`}</span>
          <svg
            className={`h-3 w-3 shrink-0 text-zinc-600 transition-all group-hover:text-zinc-400 ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
      )}

      {/* Steps — VSCode-style timeline: dashed vertical guide on the
          left, rows hang off it. No scroll container, no max-height —
          the chat grows naturally with each new tool event so the user
          watches steps roll in instead of fighting an inner scroller.
          When the turn ends the whole thing collapses behind the
          "Thought for Xs" stub above; click re-expands it in place. */}
      {expanded && (
        <div className="my-1 ml-1.5 border-l border-dashed border-zinc-600 pl-3">
          {messages.map((m) => (
            <CompactToolRow key={m.id} message={m} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Tool Card Icons ─────────────────────────────────────────────────

const TOOL_CONFIG: Record<string, {
  icon: string
  label: string
  color: string
  bgColor: string
  borderColor: string
}> = {
  Read:         { icon: '📄', label: 'Read',          color: 'text-blue-400',    bgColor: 'bg-blue-500/5',    borderColor: 'border-blue-500/20' },
  Write:        { icon: '📝', label: 'Write',         color: 'text-emerald-400', bgColor: 'bg-emerald-500/5', borderColor: 'border-emerald-500/20' },
  Edit:         { icon: '✏️',  label: 'Edit',          color: 'text-amber-400',   bgColor: 'bg-amber-500/5',   borderColor: 'border-amber-500/20' },
  MultiEdit:    { icon: '✏️',  label: 'Multi Edit',    color: 'text-amber-400',   bgColor: 'bg-amber-500/5',   borderColor: 'border-amber-500/20' },
  Bash:         { icon: '⚡',  label: 'Terminal',      color: 'text-violet-400',  bgColor: 'bg-violet-500/5',  borderColor: 'border-violet-500/20' },
  Grep:         { icon: '🔍', label: 'Search',        color: 'text-cyan-400',    bgColor: 'bg-cyan-500/5',    borderColor: 'border-cyan-500/20' },
  Glob:         { icon: '📂', label: 'Find Files',    color: 'text-cyan-400',    bgColor: 'bg-cyan-500/5',    borderColor: 'border-cyan-500/20' },
  LS:           { icon: '📁', label: 'List Dir',      color: 'text-zinc-400',    bgColor: 'bg-zinc-500/5',    borderColor: 'border-zinc-500/20' },
  Agent:        { icon: '🤖', label: 'Sub-agent',     color: 'text-pink-400',    bgColor: 'bg-pink-500/5',    borderColor: 'border-pink-500/20' },
  Task:         { icon: '🤖', label: 'Sub-agent',     color: 'text-pink-400',    bgColor: 'bg-pink-500/5',    borderColor: 'border-pink-500/20' },
  WebFetch:     { icon: '🌐', label: 'Fetch URL',     color: 'text-indigo-400',  bgColor: 'bg-indigo-500/5',  borderColor: 'border-indigo-500/20' },
  WebSearch:    { icon: '🔎', label: 'Web Search',    color: 'text-indigo-400',  bgColor: 'bg-indigo-500/5',  borderColor: 'border-indigo-500/20' },
  TodoWrite:    { icon: '✅', label: 'Tasks',         color: 'text-emerald-400', bgColor: 'bg-emerald-500/5', borderColor: 'border-emerald-500/20' },
  TodoRead:     { icon: '📋', label: 'Tasks',         color: 'text-zinc-400',    bgColor: 'bg-zinc-500/5',    borderColor: 'border-zinc-500/20' },
  NotebookEdit: { icon: '📓', label: 'Notebook',      color: 'text-orange-400',  bgColor: 'bg-orange-500/5',  borderColor: 'border-orange-500/20' },
  NotebookRead: { icon: '📓', label: 'Notebook',      color: 'text-orange-400',  bgColor: 'bg-orange-500/5',  borderColor: 'border-orange-500/20' },
}

const DEFAULT_CONFIG = { icon: '🔧', label: 'Tool', color: 'text-zinc-400', bgColor: 'bg-zinc-500/5', borderColor: 'border-zinc-500/20' }

// ── Main Component ──────────────────────────────────────────────────

export function ClaudeToolCard({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState(false)
  const config = TOOL_CONFIG[message.toolName ?? ''] ?? DEFAULT_CONFIG
  const hasResult = message.toolResult !== undefined
  const isLoading = !hasResult
  const isError = message.toolError

  return (
    <div className={`my-1.5 overflow-hidden rounded-lg border ${config.borderColor} ${config.bgColor}`}>
      {/* Header — always visible, click to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/5"
      >
        {/* Icon */}
        <span className="text-[13px]">{config.icon}</span>

        {/* Tool name + file/command */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`text-[11px] font-semibold ${config.color}`}>
              {config.label}
            </span>
            {message.filePath && (
              <span className="truncate text-[11px] text-zinc-500 font-mono">
                {message.filePath}
              </span>
            )}
            {message.command && (
              <span className="truncate text-[11px] text-zinc-500 font-mono">
                {message.command.length > 60
                  ? message.command.slice(0, 60) + '…'
                  : message.command}
              </span>
            )}
            {message.searchPattern && (
              <span className="truncate text-[11px] text-zinc-500 font-mono">
                &quot;{message.searchPattern}&quot;
              </span>
            )}
          </div>
        </div>

        {/* Status indicator */}
        {isLoading && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />
        )}
        {hasResult && !isError && (
          <svg className="h-3 w-3 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        )}
        {isError && (
          <svg className="h-3 w-3 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        )}

        {/* Expand chevron */}
        {hasResult && (
          <svg
            className={`h-3 w-3 shrink-0 text-zinc-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        )}
      </button>

      {/* Expanded content — tool-specific rendering */}
      {expanded && hasResult && (
        <div className="border-t border-white/5">
          <ToolResultContent message={message} />
        </div>
      )}
    </div>
  )
}

// ── Tool-specific result renderers ──────────────────────────────────

function ToolResultContent({ message }: { message: ChatMessage }) {
  const { toolName } = message

  switch (toolName) {
    case 'Edit':
    case 'MultiEdit':
      return <EditResult message={message} />
    case 'Bash':
      return <BashResult message={message} />
    case 'Read':
      return <FileContentResult message={message} />
    case 'Grep':
    case 'Glob':
      return <SearchResult message={message} />
    default:
      return <GenericResult message={message} />
  }
}

// ── Edit diff view ──────────────────────────────────────────────────

function EditResult({ message }: { message: ChatMessage }) {
  if (!message.oldString && !message.newString) {
    return <GenericResult message={message} />
  }

  return (
    <div className="max-h-64 overflow-y-auto font-mono text-[11px] leading-[1.6]">
      {message.oldString && (
        <div className="bg-red-500/10 px-3 py-0.5">
          {message.oldString.split('\n').map((line, i) => (
            <div key={`old-${i}`} className="flex">
              <span className="mr-2 select-none text-red-500/60">-</span>
              <span className="text-red-300">{line || '\u00A0'}</span>
            </div>
          ))}
        </div>
      )}
      {message.newString && (
        <div className="bg-emerald-500/10 px-3 py-0.5">
          {message.newString.split('\n').map((line, i) => (
            <div key={`new-${i}`} className="flex">
              <span className="mr-2 select-none text-emerald-500/60">+</span>
              <span className="text-emerald-300">{line || '\u00A0'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Bash command output ─────────────────────────────────────────────

function BashResult({ message }: { message: ChatMessage }) {
  const output = message.bashOutput ?? message.toolResult ?? ''
  const lines = output.split('\n')
  const truncated = lines.length > 30

  return (
    <div className="max-h-64 overflow-y-auto">
      {message.command && (
        <div className="border-b border-white/5 bg-black/20 px-3 py-1.5">
          <span className="font-mono text-[11px] text-violet-300">$ {message.command}</span>
        </div>
      )}
      <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-400">
        {truncated ? lines.slice(0, 30).join('\n') + `\n... (${lines.length - 30} more lines)` : output}
      </pre>
    </div>
  )
}

// ── File content preview ────────────────────────────────────────────

function FileContentResult({ message }: { message: ChatMessage }) {
  const content = message.toolResult ?? ''
  const lines = content.split('\n')
  const truncated = lines.length > 40

  return (
    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-400">
      {truncated ? lines.slice(0, 40).join('\n') + `\n... (${lines.length - 40} more lines)` : content}
    </pre>
  )
}

// ── Search results (Grep/Glob) ──────────────────────────────────────

function SearchResult({ message }: { message: ChatMessage }) {
  const results = (message.toolResult ?? '').split('\n').filter(Boolean)
  const count = results.length

  return (
    <div className="max-h-48 overflow-y-auto px-3 py-2">
      <div className="mb-1 text-[10px] text-zinc-500">{count} result{count !== 1 ? 's' : ''}</div>
      {results.slice(0, 20).map((line, i) => (
        <div key={i} className="truncate font-mono text-[11px] text-zinc-400 hover:text-zinc-200">
          {line}
        </div>
      ))}
      {count > 20 && (
        <div className="mt-1 text-[10px] text-zinc-600">... and {count - 20} more</div>
      )}
    </div>
  )
}

// ── Generic fallback ────────────────────────────────────────────────

function GenericResult({ message }: { message: ChatMessage }) {
  const content = message.toolResult ?? ''
  if (!content) return null

  return (
    <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-[1.5] text-zinc-400">
      {content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content}
    </pre>
  )
}

// ── Session Result Footer ───────────────────────────────────────────

export function SessionResultCard({ message }: { message: ChatMessage }) {
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] px-3 py-2 text-[10px]">
      {message.costUsd !== undefined && (
        <span className="text-zinc-500">
          Cost: <span className="font-mono text-zinc-300">${message.costUsd.toFixed(4)}</span>
        </span>
      )}
      {message.durationMs !== undefined && (
        <span className="text-zinc-500">
          Duration: <span className="font-mono text-zinc-300">{(message.durationMs / 1000).toFixed(1)}s</span>
        </span>
      )}
      {message.numTurns !== undefined && (
        <span className="text-zinc-500">
          Turns: <span className="font-mono text-zinc-300">{message.numTurns}</span>
        </span>
      )}
    </div>
  )
}

// ── Mode Selector ───────────────────────────────────────────────────

// IDs match the documented Claude Code `--permission-mode` values via
// the daemon's MODE_MAP. Labels here use the friendlier names the
// Bornastar exposes three modes (Plan/Ask/Agent) on top of Claude Code's
// CLI primitives. Plan = the CLI's plan mode (Anthropic-tuned plan output);
// Ask = bypassPermissions + Edit/Write/MultiEdit/NotebookEdit blacklisted
// at the CLI level + a system-prompt rule to keep destructive bash off;
// Agent = bypassPermissions, no restrictions. See companion/src/claude-bridge.ts
// for the full mapping.
type ModeId = 'plan' | 'ask' | 'agent'

const MODE_ICONS: Record<ModeId, (props: { className?: string }) => React.ReactElement> = {
  plan: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 12h6M9 16h4" />
    </svg>
  ),
  ask: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  ),
  agent: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </svg>
  ),
}

const MODES: { id: ModeId; label: string; desc: string }[] = [
  { id: 'plan', label: 'Plan', desc: 'Structured plan output, no execution' },
  { id: 'ask', label: 'Ask', desc: 'Read & search freely, no file changes' },
  { id: 'agent', label: 'Agent', desc: 'Full autonomy, executes everything' },
]

export function ModeSelector({
  mode,
  onChange,
}: {
  mode: ModeId
  onChange: (mode: ModeId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Fallback to Agent (the daemon default). Old persisted ids like
  // 'edit' from before the rename land here and render as Agent — the
  // closest semantic match for "auto-accept everything" — instead of
  // showing a blank label.
  const current = MODES.find((m) => m.id === mode) ?? MODES[2]
  const CurrentIcon = MODE_ICONS[current.id]

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Mode: ${current.label} — ${current.desc}`}
        className="flex items-center gap-1 rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none transition-colors hover:bg-white/10"
      >
        <CurrentIcon className="h-3 w-3" />
        {current.label}
        <svg className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[200px] overflow-hidden rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] shadow-xl shadow-black/40">
          {MODES.map((m) => {
            const Icon = MODE_ICONS[m.id]
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); setOpen(false) }}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-white/5 ${
                  mode === m.id ? 'bg-white/5 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                <Icon className="mt-[1px] h-3.5 w-3.5 text-zinc-400" />
                <span className="flex-1">
                  <span className="block font-medium text-zinc-200">{m.label}</span>
                  <span className="block text-[10px] text-zinc-500">{m.desc}</span>
                </span>
                {mode === m.id && (
                  <svg className="mt-[2px] h-3 w-3 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Model Selector ──────────────────────────────────────────────────

type ModelId = 'haiku' | 'sonnet' | 'opus'

const MODEL_ICONS: Record<ModelId, (props: { className?: string }) => React.ReactElement> = {
  haiku: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" />
    </svg>
  ),
  sonnet: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  ),
  opus: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l2.39 7.36H22l-6.2 4.51L18.18 22 12 17.27 5.82 22l2.38-8.13L2 9.36h7.61L12 2z" />
    </svg>
  ),
}

const MODELS: { id: ModelId; label: string; desc: string }[] = [
  { id: 'haiku', label: 'Haiku 4.5', desc: 'Fast, cheap, short answers' },
  { id: 'sonnet', label: 'Sonnet 4.6', desc: 'Balanced default' },
  { id: 'opus', label: 'Opus 4.7', desc: 'Deepest reasoning, costs more' },
]

export function ModelSelector({
  model,
  onChange,
}: {
  model: ModelId
  onChange: (model: ModelId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = MODELS.find((m) => m.id === model) ?? MODELS[1]
  const CurrentIcon = MODEL_ICONS[current.id]

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Model: ${current.label} — ${current.desc}`}
        className="flex items-center gap-1 rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none transition-colors hover:bg-white/10"
      >
        <CurrentIcon className="h-3 w-3" />
        {current.label}
        <svg className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[200px] overflow-hidden rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] shadow-xl shadow-black/40">
          {MODELS.map((m) => {
            const Icon = MODEL_ICONS[m.id]
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onChange(m.id); setOpen(false) }}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-white/5 ${
                  model === m.id ? 'bg-white/5 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                <Icon className="mt-[1px] h-3.5 w-3.5 text-zinc-400" />
                <span className="flex-1">
                  <span className="block font-medium text-zinc-200">{m.label}</span>
                  <span className="block text-[10px] text-zinc-500">{m.desc}</span>
                </span>
                {model === m.id && (
                  <svg className="mt-[2px] h-3 w-3 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Thinking Selector ───────────────────────────────────────────────

type ThinkingId = 'off' | 'low' | 'medium' | 'high'

const THINKING_ICONS: Record<ThinkingId, (props: { className?: string }) => React.ReactElement> = {
  off: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M4.93 4.93l14.14 14.14" />
    </svg>
  ),
  low: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21h6M12 3a7 7 0 00-4 12.7V18h8v-2.3A7 7 0 0012 3z" />
    </svg>
  ),
  medium: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.64 5.64l2.12 2.12M16.24 16.24l2.12 2.12M5.64 18.36l2.12-2.12M16.24 7.76l2.12-2.12" />
    </svg>
  ),
  high: ({ className }) => (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2C9 5 9 8 12 12s3 7 0 10M8 6c-2 2-2 4 0 6s2 4 0 6M16 6c2 2 2 4 0 6s-2 4 0 6" />
    </svg>
  ),
}

const THINKINGS: { id: ThinkingId; label: string; desc: string }[] = [
  { id: 'off',    label: 'No thinking',   desc: 'Respond directly, no reasoning budget' },
  { id: 'low',    label: 'Think',         desc: '~4k tokens of reasoning' },
  { id: 'medium', label: 'Think hard',    desc: '~10k tokens of reasoning' },
  { id: 'high',   label: 'Ultrathink',    desc: '~32k tokens (max budget)' },
]

export function ThinkingSelector({
  thinking,
  onChange,
}: {
  thinking: ThinkingId
  onChange: (thinking: ThinkingId) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = THINKINGS.find((t) => t.id === thinking) ?? THINKINGS[0]
  const CurrentIcon = THINKING_ICONS[current.id]

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`Thinking: ${current.label} — ${current.desc}`}
        className="flex items-center gap-1 rounded border border-[#2B2B2B] bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 outline-none transition-colors hover:bg-white/10"
      >
        <CurrentIcon className="h-3 w-3" />
        {current.label}
        <svg className={`h-2.5 w-2.5 transition-transform ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[220px] overflow-hidden rounded-lg border border-[#2B2B2B] bg-[#1B1B1B] shadow-xl shadow-black/40">
          {THINKINGS.map((t) => {
            const Icon = THINKING_ICONS[t.id]
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => { onChange(t.id); setOpen(false) }}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left text-[11px] transition-colors hover:bg-white/5 ${
                  thinking === t.id ? 'bg-white/5 text-zinc-100' : 'text-zinc-400'
                }`}
              >
                <Icon className="mt-[1px] h-3.5 w-3.5 text-zinc-400" />
                <span className="flex-1">
                  <span className="block font-medium text-zinc-200">{t.label}</span>
                  <span className="block text-[10px] text-zinc-500">{t.desc}</span>
                </span>
                {thinking === t.id && (
                  <svg className="mt-[2px] h-3 w-3 text-zinc-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Cost Tracker ────────────────────────────────────────────────────

export function CostTracker({
  costUsd,
  sessionId,
}: {
  costUsd: number
  sessionId: string | null
}) {
  if (costUsd === 0 && !sessionId) return null

  return (
    <div className="flex items-center gap-2 text-[10px] text-zinc-600">
      {sessionId && (
        <span className="font-mono">Session: {sessionId.slice(0, 8)}…</span>
      )}
      {costUsd > 0 && (
        <span className="font-mono text-zinc-400">${costUsd.toFixed(4)}</span>
      )}
    </div>
  )
}

// ── Companion Status Badge ──────────────────────────────────────────

export function CompanionStatusBadge({
  status,
  info,
}: {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  info?: { email?: string; plan?: string; version?: string } | null
}) {
  const configs = {
    connected: { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Connected' },
    connecting: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400', label: 'Connecting…' },
    disconnected: { dot: 'bg-zinc-600', text: 'text-zinc-500', label: 'Offline' },
    error: { dot: 'bg-red-400', text: 'text-red-400', label: 'Error' },
  }
  const cfg = configs[status]

  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      <span className={`text-[10px] font-medium ${cfg.text}`}>{cfg.label}</span>
      {status === 'connected' && info?.plan && (
        <span className="text-[10px] text-zinc-600">
          · Claude {info.plan} {info.version ? `(${info.version.split(' ')[0]})` : ''}
        </span>
      )}
    </div>
  )
}
