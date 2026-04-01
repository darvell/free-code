/**
 * Creates a fake Anthropic client that routes through OpenAI's Responses API.
 *
 * Transport priority:
 * 1. WebSocket (wss://) — persistent connection, lower latency
 * 2. HTTP SSE fallback — if WebSocket fails to connect
 *
 * Intercepts `client.beta.messages.create()` — both the streaming (.withResponse())
 * and non-streaming paths — and translates between Anthropic and OpenAI formats.
 */

import type Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
} from '@anthropic-ai/sdk/error'
import { getUserAgent } from 'src/utils/http.js'
import {
  getReasoningSummaryText,
  translateToResponsesApi,
} from './translator.js'
import { OpenAIStreamAdapter } from './stream.js'
import { translateOpenAIError } from './errors.js'
import { OpenAIWebSocketTransport } from './ws.js'
import type { OpenAIAuthResult } from './auth.js'
import { logForDebugging } from '../../../utils/debug.js'

interface OpenAIClientConfig {
  auth: OpenAIAuthResult
  defaultHeaders: Record<string, string>
  timeout: number
}

// Session-scoped WebSocket transport — persists across requests
let wsTransport: OpenAIWebSocketTransport | null = null
let wsDisabled = false

export function createOpenAIClient(config: OpenAIClientConfig): Anthropic {
  const { auth, defaultHeaders, timeout } = config

  const baseUrl = auth.baseUrl.replace(/\/+$/, '')
  const responsesUrl = `${baseUrl}/responses`

  // Auth headers
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    'Content-Type': 'application/json',
    'User-Agent': getUserAgent(),
  }
  if (auth.accountId) {
    authHeaders['ChatGPT-Account-Id'] = auth.accountId
  }

  function mergeHeaders(
    extra?: Record<string, string>,
  ): Record<string, string> {
    return {
      ...defaultHeaders,
      ...authHeaders,
      ...extra,
    }
  }

  // Lazily get or create the WebSocket transport
  function getWsTransport(): OpenAIWebSocketTransport {
    if (!wsTransport) {
      wsTransport = new OpenAIWebSocketTransport({
        responsesHttpUrl: responsesUrl,
        token: auth.token,
        accountId: auth.accountId,
        extraHeaders: {
          ...defaultHeaders,
          'User-Agent': getUserAgent(),
        },
      })
    }
    return wsTransport
  }

  // --- WebSocket streaming ---
  async function executeWebSocketStreamingRequest(
    params: BetaMessageStreamParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<{
    data: AsyncIterable<BetaRawMessageStreamEvent> & { controller: AbortController }
    request_id: string | null
    response: Response
  }> {
    const model =
      ((params as Record<string, unknown>).model as string) || 'gpt-4o'
    const requestBody = translateToResponsesApi(params, model)

    const transport = getWsTransport()

    // Connect if not already
    if (!transport.isConnected) {
      await transport.connect()
    }

    const generator = transport.streamRequest(
      requestBody as unknown as Record<string, unknown>,
      model,
      options?.signal,
    )

    // Wrap the generator to match the expected interface
    const controller = new AbortController()
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      })
    }

    const iterableWithController = Object.assign(generator, { controller })

    // Create a synthetic Response for the parts of the code that access it
    const syntheticResponse = new Response(null, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })

    return {
      data: iterableWithController,
      request_id: null,
      response: syntheticResponse,
    }
  }

  // --- HTTP SSE streaming (fallback) ---
  async function executeHttpStreamingRequest(
    params: BetaMessageStreamParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<{
    data: OpenAIStreamAdapter
    request_id: string | null
    response: Response
  }> {
    const model =
      ((params as Record<string, unknown>).model as string) || 'gpt-4o'
    const requestBody = translateToResponsesApi(params, model)

    const headers = mergeHeaders(options?.headers)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      })
    }

    let response: Response
    try {
      response = await fetch(responsesUrl, {
        method: 'POST',
        headers: {
          ...headers,
          // Disable automatic decompression for SSE streams. Bun's fetch
          // auto-decompresses gzip/br, but a truncated or interrupted
          // compressed SSE chunk causes a ZlibError. Plain-text SSE is
          // negligible overhead and avoids mid-stream decompression failures.
          'Accept-Encoding': 'identity',
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeoutId)
      if (
        err instanceof DOMException ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        if (controller.signal.aborted && !options?.signal?.aborted) {
          throw new APIConnectionTimeoutError()
        }
        const { APIUserAbortError } = await import('@anthropic-ai/sdk/error')
        throw new APIUserAbortError()
      }
      throw new APIConnectionError({
        message: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
        cause: err instanceof Error ? err : undefined,
      })
    }

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw await translateOpenAIError(response)
    }

    const stream = new OpenAIStreamAdapter(response, model, options?.signal)

    return {
      data: stream,
      request_id: response.headers.get('x-request-id'),
      response,
    }
  }

  // --- Combined streaming: WS first, fallback to HTTP ---
  async function executeStreamingRequest(
    params: BetaMessageStreamParams,
    options?: { signal?: AbortSignal; headers?: Record<string, string> },
  ) {
    // Try WebSocket if not disabled
    if (!wsDisabled) {
      try {
        return await executeWebSocketStreamingRequest(params, options)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logForDebugging(
          `[OpenAI WS] WebSocket failed, falling back to HTTP SSE: ${msg}`,
        )
        // Disable WebSocket for the rest of the session
        wsDisabled = true
        if (wsTransport) {
          wsTransport.cleanup()
          wsTransport = null
        }
      }
    }

    // Fallback to HTTP SSE
    return executeHttpStreamingRequest(params, options)
  }

  // --- Non-streaming ---
  async function executeNonStreamingRequest(
    params: BetaMessageStreamParams,
    options?: {
      signal?: AbortSignal
      timeout?: number
      headers?: Record<string, string>
    },
  ): Promise<BetaMessage> {
    const model =
      ((params as Record<string, unknown>).model as string) || 'gpt-4o'
    const requestBody = translateToResponsesApi(params, model)
    requestBody.stream = false

    const headers = mergeHeaders(options?.headers)
    const requestTimeout = options?.timeout ?? timeout
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), requestTimeout)

    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      })
    }

    let response: Response
    try {
      response = await fetch(responsesUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeoutId)
      if (
        err instanceof DOMException ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        if (controller.signal.aborted && !options?.signal?.aborted) {
          throw new APIConnectionTimeoutError()
        }
        const { APIUserAbortError } = await import('@anthropic-ai/sdk/error')
        throw new APIUserAbortError()
      }
      throw new APIConnectionError({
        message: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
        cause: err instanceof Error ? err : undefined,
      })
    }

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw await translateOpenAIError(response)
    }

    const responseBody = (await response.json()) as Record<string, unknown>
    return responsesObjectToBetaMessage(responseBody, model)
  }

  // --- Proxy object ---
  const client = {
    beta: {
      messages: {
        create(
          params: BetaMessageStreamParams & { stream?: boolean },
          options?: {
            signal?: AbortSignal
            timeout?: number
            headers?: Record<string, string>
          },
        ): unknown {
          const isStreaming = params.stream !== false

          if (isStreaming) {
            const resultPromise = executeStreamingRequest(params, options)
            const thenable = {
              then: resultPromise.then.bind(resultPromise),
              catch: resultPromise.catch.bind(resultPromise),
              withResponse: () => resultPromise,
            }
            return thenable
          }

          return executeNonStreamingRequest(params, options)
        },
      },
    },
  } as unknown as Anthropic

  return client
}

function responsesObjectToBetaMessage(
  resp: Record<string, unknown>,
  model: string,
): BetaMessage {
  const output = (resp.output as Array<Record<string, unknown>>) ?? []
  const usage = resp.usage as Record<string, unknown> | undefined

  const content: Array<Record<string, unknown>> = []
  for (const item of output) {
    if (item.type === 'message') {
      const parts = (item.content as Array<Record<string, unknown>>) ?? []
      for (const part of parts) {
        if (part.type === 'output_text') {
          content.push({ type: 'text', text: part.text as string })
        }
      }
    } else if (item.type === 'function_call') {
      let parsedInput: unknown
      try {
        parsedInput = JSON.parse(item.arguments as string)
      } catch {
        parsedInput = {}
      }
      content.push({
        type: 'tool_use',
        id: item.call_id as string,
        name: item.name as string,
        input: parsedInput,
      })
    } else if (item.type === 'reasoning') {
      const thinking = getReasoningSummaryText(
        item.summary as
          | Array<{ type: 'output_text'; text: string }>
          | undefined,
      )
      if (thinking) {
        content.push({
          type: 'thinking',
          thinking,
          signature: '',
        })
      }
    }
  }

  const hasFunctionCalls = output.some((item) => item.type === 'function_call')
  const status = resp.status as string
  let stopReason: string
  if (hasFunctionCalls) {
    stopReason = 'tool_use'
  } else if (status === 'incomplete') {
    stopReason = 'max_tokens'
  } else {
    stopReason = 'end_turn'
  }

  const cachedTokens =
    ((usage?.input_tokens_details as Record<string, unknown>)
      ?.cached_tokens as number) ?? 0
  const rawInputTokens = (usage?.input_tokens as number) ?? 0

  return {
    id: (resp.id as string) ?? 'msg_unknown',
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      // OpenAI's input_tokens includes cached_tokens; subtract to match
      // Anthropic's additive convention (input + cache_read = total input).
      input_tokens: rawInputTokens - cachedTokens,
      output_tokens: (usage?.output_tokens as number) ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: cachedTokens,
    },
  } as unknown as BetaMessage
}
