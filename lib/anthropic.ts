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

interface CallOptions {
  encryptedToken: string
  systemPrompt: string
  userMessage: string
  model?: string
  maxTokens?: number
}

interface AnthropicResponse {
  content: { type: string; text: string }[]
  usage: { input_tokens: number; output_tokens: number }
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

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      max_tokens: options.maxTokens ?? MAX_TOKENS,
      system: options.systemPrompt,
      messages: [
        { role: 'user', content: options.userMessage },
      ],
    }),
  })

  if (!res.ok) {
    const errorBody = await res.text()
    throw new Error(`Anthropic API error (${res.status}): ${errorBody.slice(0, 200)}`)
  }

  const data: AnthropicResponse = await res.json()
  const textBlock = data.content.find((c) => c.type === 'text')

  return {
    text: textBlock?.text ?? '',
    inputTokens: data.usage.input_tokens,
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
