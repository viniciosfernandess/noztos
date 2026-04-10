// ── Message Classifier ────────────────────────────────────────────────────
//
// Uses a cheap model (GPT-4o-mini or Haiku) to classify user messages
// into the correct response mode before sending to Claude.
//
// Returns: which mode prompt to load + keywords to search relevant code.

const CLASSIFIER_PROMPT = `You are a message classifier for a coding assistant. Given a user message and the recent conversation, classify it into exactly ONE mode and extract 2-3 search keywords to find relevant code.

MODES (pick exactly one):

1. explaining-what — "what is X?", concepts, definitions, terms → output: a definition or explanation of a concept
2. explaining-how — "how does X work?", flows, processes, mechanisms → output: a description of a flow or process
3. comparing — "X vs Y", comparing technologies, approaches, tradeoffs → output: a comparison with pros/cons or recommendation
4. discussing-code — opinion WITHOUT doing: "does this make sense?", "should I use X?", "is it worth it?" → output: a technical opinion, no files changed
5. planning — building something NEW: architecture, features, modules, routes that don't exist yet → output: an implementation plan for something new
6. improving-code — code EXISTS, same external behavior, better internally: error handling, validation, security, performance, typing, simplify logic → output: improved version of existing code
7. refactoring — code EXISTS, behavior stays IDENTICAL: reorganize, extract modules, move files, eliminate duplication → output: reorganized code, same behavior
8. debugging — "it's broken", errors, bugs, unexpected behavior, "why is X happening?" → output: diagnosis and fix for something broken
9. testing — write tests, test strategy, coverage, mocking, edge cases → output: test code or test strategy
10. devops — deploy, CI/CD, Docker, infrastructure, monitoring, environments → output: deployment or infrastructure guidance
11. documentation — write README, API docs, CHANGELOG, JSDoc, comments, "what should I put in X?", "how would I document X?" → output: a document or written text about the project
12. greeting — greetings, casual openers with no technical content yet → output: a brief friendly response
13. offtopic — completely unrelated to software or the project → output: general knowledge answer
14. general — technical but doesn't fit any specific mode: mixed questions, vague project questions, "what does this file do?" → output: a direct technical answer without a fixed shape

CRITICAL RULES:

- There is NO "none" mode. Every message must be classified into one of the 14 modes above.
- If the message is ambiguous or a clear continuation ("implementa isso", "faz isso", "aplica", "continua"), look at the recent conversation and inherit the same mode that was being used. Never leave ambiguous messages without a mode.
- Only use "offtopic" for things completely unrelated to software or the project (e.g. "qual a capital da França?").
- Only use "greeting" for pure greetings with no technical content.
- Use "general" when the message is about the project or code but doesn't sharply fit explaining, planning, debugging, refactoring, improving, comparing, discussing, testing, devops, or documentation.

KEYWORDS — 2-3 short technical terms to search in the codebase. Empty array only for greeting and offtopic.

RESPOND WITH ONLY THIS JSON, nothing else:
{"mode": "mode-name", "keywords": ["term1", "term2"]}

EXAMPLES:

"o que é WebSocket?" → {"mode": "explaining-what", "keywords": ["websocket", "socket"]}
"como funciona o fluxo de login?" → {"mode": "explaining-how", "keywords": ["login", "session", "auth"]}
"REST vs GraphQL?" → {"mode": "comparing", "keywords": ["graphql", "rest"]}
"faz sentido usar localStorage pra planos?" → {"mode": "discussing-code", "keywords": ["localStorage", "plans"]}
"quero adicionar sistema de email" → {"mode": "planning", "keywords": ["email", "smtp"]}
"melhora o error handling do server.js" → {"mode": "improving-code", "keywords": ["error", "server"]}
"refatora o auth pra separar responsabilidades" → {"mode": "refactoring", "keywords": ["auth", "middleware"]}
"tá dando 401 no login" → {"mode": "debugging", "keywords": ["401", "login", "auth"]}
"escreve testes pro approve" → {"mode": "testing", "keywords": ["approve", "test"]}
"como faço deploy pra produção?" → {"mode": "devops", "keywords": ["deploy", "production"]}
"escreve um README" → {"mode": "documentation", "keywords": ["readme"]}
"fala meu amigo!" → {"mode": "greeting", "keywords": []}
"opa voltamos!" → {"mode": "greeting", "keywords": []}
"qual a capital da França?" → {"mode": "offtopic", "keywords": []}
"me fala sobre o projeto" → {"mode": "general", "keywords": ["project", "architecture"]}
"o que faz esse arquivo?" → {"mode": "general", "keywords": ["file"]}
"cria a rota de login" → {"mode": "planning", "keywords": ["login", "route"]}
"implementa isso" [after discussing auth] → {"mode": "planning", "keywords": ["auth"]}
"faz isso" [after debugging a bug] → {"mode": "debugging", "keywords": []}
`

export interface ClassificationResult {
  mode: string
  keywords: string[]
}

// Map mode names to file names
const MODE_TO_FILE: Record<string, string> = {
  'explaining-what': 'when-explaining-what.md',
  'explaining-how': 'when-explaining-how.md',
  'comparing': 'when-comparing.md',
  'discussing-code': 'when-discussing-code.md',
  'planning': 'when-planning.md',
  'improving-code': 'when-improving-code.md',
  'refactoring': 'when-refactoring.md',
  'debugging': 'when-debugging.md',
  'testing': 'when-testing.md',
  'devops': 'when-devops.md',
  'documentation': 'when-documentation.md',
  'greeting': 'when-greeting.md',
  'offtopic': 'when-offtopic.md',
  'general': 'when-general.md',
}

export function getModeFileName(mode: string): string | null {
  return MODE_TO_FILE[mode] || null
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Classify a user message using a cheap model.
 * Falls back to 'none' if classification fails.
 * @param lastMessages - Recent conversation messages for context (optional, max 4)
 */
export async function classifyMessage(
  message: string,
  encryptedToken: string,
  lastMessages: ConversationMessage[] = []
): Promise<ClassificationResult> {
  try {
    const { decrypt } = await import('@/lib/crypto')
    const apiKey = decrypt(encryptedToken)
    if (!apiKey) return { mode: 'general', keywords: [] }

    // Build messages array: include conversation history for context, then the classify request
    const historyContext = lastMessages.length > 0
      ? `Recent conversation (for context only):\n${lastMessages
          .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 200)}`)
          .join('\n')}\n\nNow classify this message:`
      : null

    const userContent = historyContext
      ? `${historyContext}\n${message}`
      : message

    // Use Anthropic Haiku (cheapest Claude model)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 80,
        system: CLASSIFIER_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    })

    const data = await res.json()

    if (!res.ok) {
      console.error('[classifier] API error:', data.error?.message)
      return { mode: 'general', keywords: [] }
    }

    const raw = data.content?.[0]?.text?.trim()
    if (!raw) return { mode: 'general', keywords: [] }

    // Strip markdown code block if Haiku wraps the JSON (e.g. ```json ... ```)
    const text = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()

    // Parse JSON response
    const parsed = JSON.parse(text)
    const mode = typeof parsed.mode === 'string' ? parsed.mode : 'none'
    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((k: unknown) => typeof k === 'string').slice(0, 3)
      : []

    // Validate mode exists
    if (mode !== 'none' && !MODE_TO_FILE[mode]) {
      console.warn('[classifier] Unknown mode:', mode)
      return { mode: 'general', keywords }
    }

    console.log(`[classifier] "${message.slice(0, 50)}..." → mode: ${mode}, keywords: [${keywords.join(', ')}]`)
    return { mode, keywords }
  } catch (err) {
    console.error('[classifier] Failed:', err)
    return { mode: 'general', keywords: [] }
  }
}
