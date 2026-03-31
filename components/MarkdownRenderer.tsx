'use client'

import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
    >
      {copied ? (
        <>
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </>
      )}
    </button>
  )
}

// Language display names
const LANG_LABELS: Record<string, string> = {
  js: 'JavaScript',
  javascript: 'JavaScript',
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  jsx: 'JSX',
  py: 'Python',
  python: 'Python',
  bash: 'Bash',
  sh: 'Shell',
  shell: 'Shell',
  json: 'JSON',
  html: 'HTML',
  css: 'CSS',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
  md: 'Markdown',
  markdown: 'Markdown',
  dockerfile: 'Dockerfile',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
}

export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Code blocks with syntax highlighting
        code({ node, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '')
          const lang = match ? match[1] : null
          const codeString = String(children).replace(/\n$/, '')
          const isInline = !className && !codeString.includes('\n')

          if (isInline) {
            return (
              <code className="rounded bg-white/10 px-1.5 py-0.5 text-[13px] text-violet-300" {...props}>
                {children}
              </code>
            )
          }

          return (
            <div className="group relative my-2 overflow-hidden rounded-lg border border-white/10 bg-[#1e1e1e]">
              {/* Header bar with language + copy */}
              <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3 py-1">
                <span className="text-[11px] font-medium text-zinc-500">
                  {lang ? (LANG_LABELS[lang] || lang) : 'Code'}
                </span>
                <CopyButton text={codeString} />
              </div>
              {/* Code */}
              <SyntaxHighlighter
                style={vscDarkPlus}
                language={lang || 'text'}
                PreTag="div"
                customStyle={{
                  margin: 0,
                  padding: '12px 16px',
                  background: 'transparent',
                  fontSize: '13px',
                  lineHeight: '1.5',
                }}
                codeTagProps={{
                  style: { fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace' },
                }}
              >
                {codeString}
              </SyntaxHighlighter>
            </div>
          )
        },
        // Paragraphs
        p({ children }) {
          return <p className="my-3 leading-relaxed text-zinc-200">{children}</p>
        },
        // Bold
        strong({ children }) {
          return <strong className="font-semibold text-zinc-100">{children}</strong>
        },
        // Links
        a({ children, href }) {
          return <a href={href} className="text-violet-400 underline hover:text-violet-300" target="_blank" rel="noopener noreferrer">{children}</a>
        },
        // Lists
        ul({ children }) {
          return <ul className="my-3 ml-4 list-disc space-y-1 text-zinc-300">{children}</ul>
        },
        ol({ children }) {
          return <ol className="my-3 ml-4 list-decimal space-y-1 text-zinc-300">{children}</ol>
        },
        li({ children }) {
          return <li className="text-zinc-300">{children}</li>
        },
        // Headers (if Claude uses them despite rules)
        h1({ children }) {
          return <p className="my-2 text-[15px] font-semibold text-zinc-100">{children}</p>
        },
        h2({ children }) {
          return <p className="my-2 text-[15px] font-semibold text-zinc-100">{children}</p>
        },
        h3({ children }) {
          return <p className="my-1.5 text-[14px] font-semibold text-zinc-200">{children}</p>
        },
        // Blockquotes
        blockquote({ children }) {
          return <blockquote className="my-2 border-l-2 border-violet-500/50 pl-3 text-zinc-400">{children}</blockquote>
        },
        // Tables
        table({ children }) {
          return <div className="my-2 overflow-x-auto"><table className="w-full text-sm">{children}</table></div>
        },
        th({ children }) {
          return <th className="border border-white/10 bg-white/5 px-2 py-1 text-left text-zinc-300">{children}</th>
        },
        td({ children }) {
          return <td className="border border-white/10 px-2 py-1 text-zinc-400">{children}</td>
        },
        // Horizontal rule
        hr() {
          return <hr className="my-3 border-white/10" />
        },
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
