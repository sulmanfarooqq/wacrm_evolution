import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiContentPart {
  text?: string
}
interface GeminiContent {
  role?: 'user' | 'model'
  parts: GeminiContentPart[]
}
interface GeminiCandidate {
  content?: GeminiContent
}
interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/**
 * Gemini uses `user` / `model` roles where the shared surface uses
 * `user` / `assistant`. Merge consecutive turns first (the provider is
 * role-alternating like Anthropic), then map assistant → model.
 */
function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  const merged = messages.reduce<ChatMessage[]>((out, m) => {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
    return out
  }, [])
  if (merged.length === 0) {
    return [{ role: 'user', parts: [{ text: '(The customer has not sent a message yet.)' }] }]
  }
  return merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
}

/**
 * Call Google's Gemini `generateContent` endpoint with the caller's own
 * key. The key travels in the `x-goog-api-key` header (never in the
 * URL), and the model is passed inline in the path. Returns the raw
 * assistant text + token usage (handoff parsing happens in
 * `generateReply`).
 */
export async function generateGemini(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(`${GEMINI_URL}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: toGeminiContents(messages),
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Gemini', res)
  }

  const data = (await res.json().catch(() => null)) as GeminiResponse | null
  const text = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text)
    .filter((p): p is string => typeof p === 'string')
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Gemini returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Gemini reports prompt/candidates/total separately — all present.
  const usage = normalizeUsage({
    prompt: data?.usageMetadata?.promptTokenCount,
    completion: data?.usageMetadata?.candidatesTokenCount,
    total: data?.usageMetadata?.totalTokenCount,
  })
  return { text, usage }
}
