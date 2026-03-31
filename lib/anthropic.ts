import { decrypt } from '@/lib/crypto'

// Anthropic Messages API wrapper.
//
// Uses the user's encrypted token (decrypted per-request) to call the
// Anthropic API. Each collaborator's skillMd becomes the system prompt.
//
// Flow:
//   encryptedToken → decrypt → Authorization header
//   skillMd → system prompt
//   input → user message
//   → POST https://api.anthropic.com/v1/messages
//   → extract text response

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_MODEL = 'claude-sonnet-4-20250514'
const MAX_TOKENS = 4096

// Available models
export const MODELS = {
  haiku: { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', description: 'Fast & cheap' },
  sonnet: { id: 'claude-sonnet-4-20250514', name: 'Sonnet 4', description: 'Balanced' },
  opus: { id: 'claude-opus-4-20250514', name: 'Opus 4', description: 'Most capable' },
} as const

export type ModelKey = keyof typeof MODELS

// Thinking budget presets
export const THINKING_PRESETS = {
  off: { tokens: 0, label: 'Off' },
  low: { tokens: 5000, label: 'Low' },
  medium: { tokens: 10000, label: 'Medium' },
  high: { tokens: 30000, label: 'High' },
} as const

export type ThinkingLevel = keyof typeof THINKING_PRESETS

interface CallOptions {
  encryptedToken: string
  systemPrompt: string
  userMessage: string
  model?: string
  maxTokens?: number
  thinkingBudget?: number
  compactSummary?: string  // compacted context to include (will be cached)
}

interface AnthropicResponse {
  content: { type: string; text: string }[]
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

/**
 * Call the Anthropic Messages API with a system prompt and user message.
 * Returns the text response content.
 */
export async function callAnthropic(options: CallOptions): Promise<{
  text: string
  inputTokens: number
  outputTokens: number
}> {
  const apiKey = decrypt(options.encryptedToken)
  if (!apiKey) {
    throw new Error('Failed to decrypt Anthropic token')
  }

  // Build system prompt with caching
  const systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] = []

  // System prompt — always cached
  systemBlocks.push({
    type: 'text',
    text: options.systemPrompt,
    cache_control: { type: 'ephemeral' },
  })

  // Compact summary — cached if present
  if (options.compactSummary) {
    systemBlocks.push({
      type: 'text',
      text: `\n\nPREVIOUS CONVERSATION CONTEXT:\n${options.compactSummary}`,
      cache_control: { type: 'ephemeral' },
    })
  }

  const body: Record<string, unknown> = {
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? MAX_TOKENS,
    system: systemBlocks,
    messages: [
      { role: 'user', content: options.userMessage },
    ],
  }

  // Extended thinking
  if (options.thinkingBudget && options.thinkingBudget > 0) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: options.thinkingBudget,
    }
    body.max_tokens = Math.max(options.maxTokens ?? MAX_TOKENS, options.thinkingBudget + MAX_TOKENS)
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`Anthropic API error (${res.status}): ${errorBody.slice(0, 200)}`)
  }

  const data: AnthropicResponse = await res.json()
  const textBlock = data.content.find((c) => c.type === 'text')

  return {
    text: textBlock?.text ?? '',
    inputTokens: data.usage.input_tokens + (data.usage.cache_read_input_tokens ?? 0) + (data.usage.cache_creation_input_tokens ?? 0),
    outputTokens: data.usage.output_tokens,
  }
}

/**
 * Simple chat call — no system prompt, just user message.
 */
export async function callChat(
  encryptedToken: string,
  userMessage: string
): Promise<string> {
  const result = await callAnthropic({
    encryptedToken,
    systemPrompt: 'You are a helpful AI assistant working as part of an AI company. Be concise and helpful.',
    userMessage,
  })
  return result.text
}

// ── Tool Use support ─────────────────────────────────────────────────────

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface TextBlock {
  type: 'text'
  text: string
}

type ContentBlock = ToolUseBlock | TextBlock

interface ToolCallMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

interface ToolCallOptions {
  encryptedToken: string
  systemPrompt: string
  messages: ToolCallMessage[]
  tools: ToolDefinition[]
  model?: string
  maxTokens?: number
  thinkingBudget?: number
}

interface ToolCallApiResponse {
  content: ContentBlock[]
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens'
  usage: { input_tokens: number; output_tokens: number }
}

/**
 * Call the Anthropic Messages API with tool definitions.
 * Returns the full content blocks and stop reason for agentic loop handling.
 */
export async function callAnthropicWithTools(options: ToolCallOptions): Promise<{
  content: ContentBlock[]
  stopReason: string
  inputTokens: number
  outputTokens: number
}> {
  const apiKey = decrypt(options.encryptedToken)
  if (!apiKey) throw new Error('Failed to decrypt Anthropic token')

  // System prompt as cached blocks (same format as callAnthropic)
  const systemBlocks: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] = [
    { type: 'text', text: options.systemPrompt, cache_control: { type: 'ephemeral' } },
  ]

  const body: Record<string, unknown> = {
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? MAX_TOKENS,
    system: systemBlocks,
    messages: options.messages,
    tools: options.tools,
  }

  if (options.thinkingBudget && options.thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget }
    body.max_tokens = Math.max(options.maxTokens ?? MAX_TOKENS, options.thinkingBudget + MAX_TOKENS)
  }

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`Anthropic API error (${res.status}): ${errorBody.slice(0, 200)}`)
  }

  const data: ToolCallApiResponse = await res.json()

  return {
    content: data.content,
    stopReason: data.stop_reason,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
  }
}

export type { ToolDefinition, ToolUseBlock, TextBlock, ContentBlock, ToolCallMessage }
