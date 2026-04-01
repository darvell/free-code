/**
 * Remote compaction via OpenAI's POST /responses/compact endpoint.
 *
 * When the active model is an OpenAI model, this replaces the local
 * LLM-based summarization with server-side compaction. The endpoint
 * takes the full conversation context (model, input items, instructions,
 * tools, reasoning) and returns a compacted version of the history.
 *
 * Mirrors what Codex CLI sends (codex-rs/codex-api/src/endpoint/compact.rs).
 */

import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Tool } from '../../../Tool.js'
import type { AssistantMessage, Message } from '../../../types/message.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getUserAgent } from '../../../utils/http.js'
import {
  getMessagesAfterCompactBoundary,
  normalizeMessagesForAPI,
} from '../../../utils/messages.js'
import { zodToJsonSchema } from '../../../utils/zodToJsonSchema.js'
import { getOpenAIAuth } from './auth.js'
import { translateToResponsesApi } from './translator.js'
import type {
  ResponseInputItem,
  ResponsesApiTool,
  ResponsesReasoning,
} from './types.js'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RemoteCompactOptions {
  messages: Message[]
  model: string
  tools: Tool[]
  systemPrompt: string
  effortValue?: string
  signal?: AbortSignal
}

/**
 * Calls the OpenAI remote compact endpoint and returns a synthetic
 * AssistantMessage containing the compacted summary text.
 *
 * Throws on failure so the caller can fall back to local summarization.
 */
export async function remoteCompact(
  opts: RemoteCompactOptions,
): Promise<AssistantMessage> {
  const { messages, model, tools, systemPrompt, effortValue, signal } = opts

  const auth = await getOpenAIAuth()
  const baseUrl = auth.baseUrl.replace(/\/+$/, '')
  const compactUrl = `${baseUrl}/responses/compact`

  // Build the input items by converting our messages through the existing
  // Anthropic → OpenAI translation pipeline.
  const input = buildInputItems(messages, tools, systemPrompt)

  // Build tool definitions in Responses API format
  const apiTools = buildApiTools(tools)

  // Map effort to reasoning config
  const reasoning = mapEffortToReasoning(effortValue)

  const body: Record<string, unknown> = {
    model,
    input: input.items,
    instructions: input.instructions,
    tools: apiTools,
    parallel_tool_calls: false,
  }

  if (reasoning) {
    body.reasoning = reasoning
  }

  // Build auth headers
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
  }
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId
  }

  logForDebugging(
    `[OpenAI compact] POST ${compactUrl} model=${model} input_items=${input.items.length} tools=${apiTools.length}`,
  )

  const response = await fetch(compactUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `Remote compact failed (${response.status}): ${text.slice(0, 500)}`,
    )
  }

  const result = (await response.json()) as CompactResponse
  const summary = extractSummaryText(result)

  if (!summary) {
    throw new Error(
      'Remote compact returned no readable text in output',
    )
  }

  logForDebugging(
    `[OpenAI compact] Got summary (${summary.length} chars)`,
  )

  return buildSyntheticAssistantMessage(summary, model)
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

interface InputResult {
  items: ResponseInputItem[]
  instructions: string
}

/**
 * Converts our Message[] into ResponseInputItem[] by piping through
 * normalizeMessagesForAPI → synthetic BetaMessageStreamParams →
 * translateToResponsesApi, then extracting the `input` and `instructions`.
 */
function buildInputItems(
  messages: Message[],
  tools: Tool[],
  systemPrompt: string,
): InputResult {
  // Get messages after the last compact boundary and normalize for API
  const messagesAfterBoundary = getMessagesAfterCompactBoundary(messages)
  const normalized = normalizeMessagesForAPI(
    messagesAfterBoundary,
    tools,
  )

  // Build a synthetic BetaMessageStreamParams so we can reuse translateToResponsesApi.
  // The normalized messages have { type: 'user'|'assistant', message: { role, content } }.
  // BetaMessageStreamParams expects messages as { role: 'user'|'assistant', content: ... }.
  const betaMessages = normalized.map((msg) => ({
    role: msg.message.role as 'user' | 'assistant',
    content: msg.message.content,
  }))

  const syntheticParams = {
    model: '', // not used for input translation
    max_tokens: 0, // not used
    messages: betaMessages,
    system: systemPrompt,
  } as unknown as BetaMessageStreamParams

  const translated = translateToResponsesApi(syntheticParams, '')
  return {
    items: translated.input,
    instructions: translated.instructions ?? systemPrompt,
  }
}

/**
 * Converts Tool[] directly to ResponsesApiTool[].
 * Uses inputJSONSchema if available (MCP tools), otherwise converts
 * the Zod inputSchema to JSON Schema.
 */
function buildApiTools(tools: Tool[]): ResponsesApiTool[] {
  return tools
    .filter((t) => t.isEnabled())
    .map((tool) => {
      const schema =
        'inputJSONSchema' in tool && tool.inputJSONSchema
          ? (tool.inputJSONSchema as Record<string, unknown>)
          : (zodToJsonSchema(tool.inputSchema) as Record<string, unknown>)

      return {
        type: 'function' as const,
        name: tool.name,
        description: tool.name, // compact only needs schema for token counting
        parameters: schema,
      }
    })
}

function mapEffortToReasoning(
  effort: string | undefined,
): ResponsesReasoning | undefined {
  if (!effort) return undefined

  const effortMap: Record<string, ResponsesReasoning['effort']> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'xhigh',
  }

  const mapped = effortMap[effort]
  if (!mapped) return undefined

  return {
    effort: mapped,
    summary: 'auto',
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface CompactResponse {
  output: CompactOutputItem[]
}

interface CompactOutputItem {
  type: string
  role?: string
  content?: Array<{ type: string; text?: string }>
  encrypted_content?: string
}

/**
 * Extracts readable summary text from the compact response.
 *
 * The response contains a mix of:
 * - message items (role: "user") with input_text content — preserved user messages
 * - compaction_summary items with encrypted_content — opaque server-side markers
 *
 * We collect text from user-role message items that contain input_text content.
 */
function extractSummaryText(response: CompactResponse): string | null {
  if (!response.output || !Array.isArray(response.output)) {
    return null
  }

  const texts: string[] = []

  for (const item of response.output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (
          (part.type === 'input_text' || part.type === 'output_text') &&
          typeof part.text === 'string' &&
          part.text.trim().length > 0
        ) {
          texts.push(part.text)
        }
      }
    }
  }

  if (texts.length === 0) {
    return null
  }

  return texts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Synthetic response
// ---------------------------------------------------------------------------

function buildSyntheticAssistantMessage(
  summary: string,
  model: string,
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: randomUUID(),
      container: null,
      model,
      role: 'assistant',
      stop_reason: 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        inference_geo: null,
        iterations: null,
        speed: null,
      },
      content: [{ type: 'text' as const, text: summary }],
      context_management: null,
    },
    requestId: undefined,
  } as unknown as AssistantMessage
}
