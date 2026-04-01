/**
 * Translates between Anthropic BetaMessageStreamParams and OpenAI Responses API format,
 * and between Responses API SSE events and Anthropic BetaRawMessageStreamEvent.
 */

import type {
  BetaContentBlockParam,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaToolUnion,
  BetaMessageParam as MessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import type {
  InputContentPart,
  InputFunctionCall,
  InputFunctionCallOutput,
  InputMessage,
  OutputContentPart,
  ResponseInputItem,
  ResponseObject,
  ResponsesApiRequest,
  ResponsesApiTool,
  ResponsesReasoning,
  ResponsesStreamEvent,
} from './types.js'

// ---------------------------------------------------------------------------
// Request translation: Anthropic -> OpenAI Responses API
// ---------------------------------------------------------------------------

const OPENAI_HARNESS_ADDENDUM = `# Claude Code harness addendum

You are running inside the Claude Code harness.

Follow explicit developer, system, and user instructions over any generic model defaults.

Complete multi-step work to a real stopping point before ending your turn. Do not pause partway through exploration, implementation, or verification just to ask whether to continue unless the user asked for a checkpoint.

Keep check-ins rare. Ask questions only for real blockers, missing requirements, or risky actions that need confirmation.

Report outcomes plainly. Say what you changed, what you verified, and what is still unresolved. Do not present incomplete work as finished.`

function appendOpenAIHarnessAddendum(instructions: string | undefined): string {
  return instructions
    ? `${instructions}\n\n${OPENAI_HARNESS_ADDENDUM}`
    : OPENAI_HARNESS_ADDENDUM
}

function mapEffortToOpenAIReasoning(
  effort: unknown,
): ResponsesReasoning['effort'] | undefined {
  switch (effort) {
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    case 'high':
      return 'high'
    case 'max':
      return 'xhigh'
    default:
      return undefined
  }
}

function mapThinkingToOpenAIReasoning(
  params: BetaMessageStreamParams,
): ResponsesReasoning | undefined {
  const outputConfig = (params as Record<string, unknown>).output_config as
    | Record<string, unknown>
    | undefined
  const effortFromOutputConfig = mapEffortToOpenAIReasoning(outputConfig?.effort)
  if (effortFromOutputConfig) {
    return {
      effort: effortFromOutputConfig,
      summary: 'detailed',
    }
  }

  const thinking = params.thinking as Record<string, unknown> | undefined
  if (!thinking || (thinking.type !== 'enabled' && thinking.type !== 'adaptive')) {
    return undefined
  }

  const budgetTokens = thinking.budget_tokens as number | undefined
  let effort: ResponsesReasoning['effort'] = 'medium'
  if (budgetTokens !== undefined) {
    if (budgetTokens <= 2_000) effort = 'minimal'
    else if (budgetTokens <= 10_000) effort = 'low'
    else if (budgetTokens <= 30_000) effort = 'medium'
    else if (budgetTokens <= 60_000) effort = 'high'
    else effort = 'xhigh'
  }

  return {
    effort,
    summary: 'detailed',
  }
}

export function getReasoningSummaryText(
  summary: OutputContentPart[] | undefined,
): string {
  return (summary ?? [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('')
}

export function translateToResponsesApi(
  params: BetaMessageStreamParams,
  model: string,
): ResponsesApiRequest {
  const input: ResponseInputItem[] = []
  let instructions: string | undefined

  // System prompt -> instructions
  if (params.system) {
    if (typeof params.system === 'string') {
      instructions = params.system
    } else if (Array.isArray(params.system)) {
      const texts: string[] = []
      for (const block of params.system) {
        if ('text' in block && typeof block.text === 'string') {
          texts.push(block.text)
        }
      }
      instructions = texts.join('\n\n')
    }
  }

  instructions = appendOpenAIHarnessAddendum(instructions)

  // Messages -> input items
  for (const msg of params.messages) {
    if (msg.role === 'user') {
      translateUserMessage(msg, input)
    } else if (msg.role === 'assistant') {
      translateAssistantMessage(msg, input)
    }
  }

  // Tools
  const tools: ResponsesApiTool[] | undefined = params.tools?.map(translateTool)

  // Tool choice
  let tool_choice: ResponsesApiRequest['tool_choice']
  if (params.tool_choice) {
    const tc = params.tool_choice as Record<string, unknown>
    if (tc.type === 'auto') {
      tool_choice = 'auto'
    } else if (tc.type === 'any') {
      tool_choice = 'required'
    } else if (tc.type === 'tool' && tc.name) {
      tool_choice = { type: 'function', name: tc.name as string }
    }
  }

  // Reasoning from thinking config
  // Maps Anthropic thinking budget to OpenAI Responses API reasoning effort.
  // Codex supports: none, minimal, low, medium, high, xhigh
  const reasoning = mapThinkingToOpenAIReasoning(params)

  const request: ResponsesApiRequest = {
    model,
    input,
    stream: true,
    store: false,
    tools: tools && tools.length > 0 ? tools : [],
    tool_choice: tool_choice ?? 'auto',
    parallel_tool_calls: false,
    include: reasoning ? ['reasoning.encrypted_content'] : [],
  }

  if (instructions) request.instructions = instructions
  if (reasoning) request.reasoning = reasoning

  return request
}

function translateUserMessage(
  msg: MessageParam,
  input: ResponseInputItem[],
): void {
  if (typeof msg.content === 'string') {
    input.push({
      type: 'message',
      role: 'user',
      content: msg.content,
    } satisfies InputMessage)
    return
  }

  // Array content — split tool_result blocks from other content
  const contentParts: InputContentPart[] = []

  for (const block of msg.content as BetaContentBlockParam[]) {
    const b = block as Record<string, unknown>
    if (b.type === 'tool_result') {
      // tool_result -> function_call_output
      let output: string
      if (typeof b.content === 'string') {
        output = b.content
      } else if (Array.isArray(b.content)) {
        output = (b.content as Array<Record<string, unknown>>)
          .filter(c => c.type === 'text')
          .map(c => c.text as string)
          .join('\n')
      } else {
        output = ''
      }
      if (b.is_error) {
        output = `[ERROR] ${output}`
      }
      input.push({
        type: 'function_call_output',
        call_id: b.tool_use_id as string,
        output,
      } satisfies InputFunctionCallOutput)
    } else if (b.type === 'text') {
      contentParts.push({
        type: 'input_text',
        text: b.text as string,
      })
    } else if (b.type === 'image') {
      const source = b.source as Record<string, unknown>
      if (source?.type === 'base64') {
        contentParts.push({
          type: 'input_image',
          image_url: `data:${source.media_type};base64,${source.data}`,
        })
      } else if (source?.type === 'url') {
        contentParts.push({
          type: 'input_image',
          image_url: source.url as string,
        })
      }
    }
    // Skip thinking, document, and other Anthropic-specific blocks
  }

  if (contentParts.length > 0) {
    if (contentParts.length === 1 && contentParts[0]!.type === 'input_text') {
      input.push({
        type: 'message',
        role: 'user',
        content: contentParts[0]!.text!,
      } satisfies InputMessage)
    } else {
      input.push({
        type: 'message',
        role: 'user',
        content: contentParts,
      } satisfies InputMessage)
    }
  }
}

function translateAssistantMessage(
  msg: MessageParam,
  input: ResponseInputItem[],
): void {
  if (typeof msg.content === 'string') {
    input.push({
      type: 'message',
      role: 'assistant',
      content: msg.content,
    } satisfies InputMessage)
    return
  }

  const textParts: string[] = []
  const functionCalls: InputFunctionCall[] = []

  for (const block of msg.content as BetaContentBlockParam[]) {
    const b = block as Record<string, unknown>
    if (b.type === 'text') {
      textParts.push(b.text as string)
    } else if (b.type === 'tool_use') {
      functionCalls.push({
        type: 'function_call',
        call_id: b.id as string,
        name: b.name as string,
        arguments:
          typeof b.input === 'string'
            ? (b.input as string)
            : JSON.stringify(b.input),
      })
    }
    // Skip thinking blocks — OpenAI doesn't accept them back
  }

  // Emit text as assistant message
  if (textParts.length > 0) {
    input.push({
      type: 'message',
      role: 'assistant',
      content: textParts.join(''),
    } satisfies InputMessage)
  }

  // Emit each function call
  for (const fc of functionCalls) {
    input.push(fc)
  }
}

export function translateTool(tool: BetaToolUnion): ResponsesApiTool {
  const t = tool as Record<string, unknown>
  return {
    type: 'function',
    name: t.name as string,
    description: (t.description as string) || '',
    parameters: (t.input_schema as Record<string, unknown>) || {},
    strict: (t.strict as boolean) || false,
  }
}

// ---------------------------------------------------------------------------
// Response translation: OpenAI Responses SSE -> Anthropic BetaRawMessageStreamEvent
// ---------------------------------------------------------------------------

export interface TranslationState {
  messageId: string
  model: string
  contentBlockIndex: number
  outputIndexToBlockIndex: Map<number, number>
  contentPartToBlockIndex: Map<string, number>
  messageStartSent: boolean
  /** Blocks that have had content_block_start emitted (safe to close) */
  startedBlocks: Set<number>
  thinkingBlockStarted: Set<number>
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export function createTranslationState(model: string): TranslationState {
  return {
    messageId: `msg_${randomUUID().replace(/-/g, '')}`,
    model,
    contentBlockIndex: 0,
    outputIndexToBlockIndex: new Map(),
    contentPartToBlockIndex: new Map(),
    messageStartSent: false,
    startedBlocks: new Set(),
    thinkingBlockStarted: new Set(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  }
}

export function translateResponsesEvent(
  event: ResponsesStreamEvent,
  state: TranslationState,
): BetaRawMessageStreamEvent[] {
  const events: BetaRawMessageStreamEvent[] = []

  // Ensure message_start is emitted first
  if (!state.messageStartSent) {
    state.messageStartSent = true
    events.push({
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: undefined as unknown as {
            web_search_requests: number
          },
        },
      },
    } as BetaRawMessageStreamEvent)
  }

  switch (event.type) {
    case 'response.created':
    case 'response.in_progress':
      // Already handled by message_start above
      break

    case 'response.output_item.added': {
      const item = event.item
      const blockIdx = state.contentBlockIndex++
      state.outputIndexToBlockIndex.set(event.output_index, blockIdx)

      if (item.type === 'message') {
        // Text message — we'll emit content_block_start when we get the first content part
        // Don't emit yet — wait for content_part.added
      } else if (item.type === 'function_call') {
        state.startedBlocks.add(blockIdx)
        events.push({
          type: 'content_block_start',
          index: blockIdx,
          content_block: {
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: '',
          },
        } as unknown as BetaRawMessageStreamEvent)
      } else if (item.type === 'reasoning') {
        // Reasoning — track the block index but don't emit content_block_start yet.
        // We'll emit it lazily when the first reasoning_summary_text.delta arrives,
        // to avoid emitting empty thinking blocks that Anthropic rejects.
        // Don't add to startedBlocks — only add when we actually start it.
      }
      break
    }

    case 'response.content_part.added': {
      // This is a text content part inside a message output item
      const blockIdx = state.contentBlockIndex++
      const key = `${event.output_index}:${event.content_index}`
      state.contentPartToBlockIndex.set(key, blockIdx)
      state.startedBlocks.add(blockIdx)
      events.push({
        type: 'content_block_start',
        index: blockIdx,
        content_block: {
          type: 'text',
          text: '',
        },
      } as unknown as BetaRawMessageStreamEvent)
      break
    }

    case 'response.output_text.delta': {
      const key = `${event.output_index}:${event.content_index}`
      const blockIdx = state.contentPartToBlockIndex.get(key)
      if (blockIdx !== undefined) {
        events.push({
          type: 'content_block_delta',
          index: blockIdx,
          delta: {
            type: 'text_delta',
            text: event.delta,
          },
        } as unknown as BetaRawMessageStreamEvent)
      }
      break
    }

    case 'response.function_call_arguments.delta': {
      const blockIdx = state.outputIndexToBlockIndex.get(event.output_index)
      if (blockIdx !== undefined) {
        events.push({
          type: 'content_block_delta',
          index: blockIdx,
          delta: {
            type: 'input_json_delta',
            partial_json: event.delta,
          },
        } as unknown as BetaRawMessageStreamEvent)
      }
      break
    }

    case 'response.reasoning_summary_text.delta': {
      const blockIdx = state.outputIndexToBlockIndex.get(event.output_index)
      if (blockIdx !== undefined) {
        // Lazily emit content_block_start for thinking on first delta
        if (!state.thinkingBlockStarted.has(blockIdx)) {
          state.thinkingBlockStarted.add(blockIdx)
          state.startedBlocks.add(blockIdx)
          events.push({
            type: 'content_block_start',
            index: blockIdx,
            content_block: {
              type: 'thinking',
              thinking: '',
              signature: '',
            },
          } as unknown as BetaRawMessageStreamEvent)
        }
        events.push({
          type: 'content_block_delta',
          index: blockIdx,
          delta: {
            type: 'thinking_delta',
            thinking: event.delta,
          },
        } as unknown as BetaRawMessageStreamEvent)
      }
      break
    }

    case 'response.content_part.done': {
      const key = `${event.output_index}:${event.content_index}`
      const blockIdx = state.contentPartToBlockIndex.get(key)
      if (blockIdx !== undefined && state.startedBlocks.has(blockIdx)) {
        state.startedBlocks.delete(blockIdx)
        events.push({
          type: 'content_block_stop',
          index: blockIdx,
        } as BetaRawMessageStreamEvent)
      }
      break
    }

    case 'response.output_item.done': {
      const blockIdx = state.outputIndexToBlockIndex.get(event.output_index)
      if (blockIdx !== undefined && state.startedBlocks.has(blockIdx)) {
        state.startedBlocks.delete(blockIdx)
        events.push({
          type: 'content_block_stop',
          index: blockIdx,
        } as BetaRawMessageStreamEvent)
      }
      break
    }

    case 'response.completed': {
      // Close any remaining started blocks
      for (const blockIdx of state.startedBlocks) {
        events.push({
          type: 'content_block_stop',
          index: blockIdx,
        } as BetaRawMessageStreamEvent)
      }
      state.startedBlocks.clear()

      const resp = event.response as ResponseObject
      const hasFunctionCalls = resp.output?.some(
        item => item.type === 'function_call',
      )
      const stopReason = hasFunctionCalls ? 'tool_use' : 'end_turn'

      // Extract usage — OpenAI's input_tokens already includes cached_tokens
      // (it's a subset), but Anthropic's convention treats them as additive.
      // Subtract cached from input so downstream (input + cache_read) is correct.
      if (resp.usage) {
        const cachedTokens =
          resp.usage.input_tokens_details?.cached_tokens ?? 0
        state.inputTokens = resp.usage.input_tokens - cachedTokens
        state.outputTokens = resp.usage.output_tokens
        state.cacheReadTokens = cachedTokens
      }

      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: stopReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: state.outputTokens,
          input_tokens: state.inputTokens,
          cache_read_input_tokens: state.cacheReadTokens,
          cache_creation_input_tokens: 0,
        },
      } as unknown as BetaRawMessageStreamEvent)

      events.push({
        type: 'message_stop',
      } as BetaRawMessageStreamEvent)
      break
    }

    case 'response.incomplete': {
      // Close any remaining open blocks
      for (const blockIdx of state.startedBlocks) {
        events.push({
          type: 'content_block_stop',
          index: blockIdx,
        } as BetaRawMessageStreamEvent)
      }
      state.startedBlocks.clear()

      const resp = event.response as ResponseObject
      if (resp.usage) {
        const cachedTokens =
          resp.usage.input_tokens_details?.cached_tokens ?? 0
        state.inputTokens = resp.usage.input_tokens - cachedTokens
        state.outputTokens = resp.usage.output_tokens
        state.cacheReadTokens = cachedTokens
      }

      events.push({
        type: 'message_delta',
        delta: {
          stop_reason: 'max_tokens',
          stop_sequence: null,
        },
        usage: {
          output_tokens: state.outputTokens,
          input_tokens: state.inputTokens,
          cache_read_input_tokens: state.cacheReadTokens,
          cache_creation_input_tokens: 0,
        },
      } as unknown as BetaRawMessageStreamEvent)

      events.push({
        type: 'message_stop',
      } as BetaRawMessageStreamEvent)
      break
    }

    case 'response.failed': {
      // The stream adapter will handle this by throwing an error
      break
    }

    default:
      // Unknown event — ignore silently
      break
  }

  return events
}
