/**
 * WebSocket transport for the OpenAI Responses API.
 *
 * Connects via wss:// to the /responses endpoint, sends requests as JSON text
 * messages, and receives the same event JSON as the SSE path. Falls back to
 * HTTP SSE if the WebSocket connection fails.
 *
 * The connection is reused across requests within a session for lower latency.
 */

import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import WebSocket from 'ws'
import {
  type TranslationState,
  createTranslationState,
  translateResponsesEvent,
} from './translator.js'
import type { ResponsesStreamEvent } from './types.js'

const WS_CONNECT_TIMEOUT_MS = 15_000
const WS_IDLE_TIMEOUT_MS = 300_000
const BETA_HEADER = 'responses_websockets=2026-02-06'

export interface WsConfig {
  /** HTTP base URL (https://...) — scheme is flipped to wss:// */
  responsesHttpUrl: string
  token: string
  accountId?: string
  extraHeaders: Record<string, string>
}

/**
 * Session-scoped WebSocket connection manager.
 * Call connect() once, then streamRequest() for each turn.
 * The connection is reused until it's closed or errors out.
 */
export class OpenAIWebSocketTransport {
  private ws: WebSocket | null = null
  private config: WsConfig
  private closed = false

  constructor(config: WsConfig) {
    this.config = config
  }

  /** Whether the WebSocket is connected and open. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  /**
   * Connect to the WebSocket endpoint.
   * Resolves when the connection is open, rejects on failure or timeout.
   */
  async connect(): Promise<void> {
    if (this.isConnected) return

    // Clean up any stale connection
    this.cleanup()

    const wsUrl = this.config.responsesHttpUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      'OpenAI-Beta': BETA_HEADER,
      ...this.config.extraHeaders,
    }
    if (this.config.accountId) {
      headers['ChatGPT-Account-Id'] = this.config.accountId
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        ws.terminate()
        reject(new Error('WebSocket connect timeout'))
      }, WS_CONNECT_TIMEOUT_MS)

      const ws = new WebSocket(wsUrl, {
        headers,
        perMessageDeflate: true,
      })

      ws.on('open', () => {
        clearTimeout(timeoutId)
        this.ws = ws
        this.closed = false
        resolve()
      })

      ws.on('error', (err) => {
        clearTimeout(timeoutId)
        this.ws = null
        reject(err)
      })

      ws.on('close', () => {
        this.ws = null
        this.closed = true
      })
    })
  }

  /**
   * Send a request over the WebSocket and return an async iterable of
   * Anthropic BetaRawMessageStreamEvent (same format as the SSE adapter).
   */
  async *streamRequest(
    requestBody: Record<string, unknown>,
    model: string,
    signal?: AbortSignal,
  ): AsyncGenerator<BetaRawMessageStreamEvent> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected')
    }

    const ws = this.ws
    const state: TranslationState = createTranslationState(model)

    // Wrap the request in the response.create envelope
    // Codex WS protocol: { type: "response.create", ...requestFields }
    const wsPayload = {
      type: 'response.create',
      ...requestBody,
    }

    // Send the request
    const requestText = JSON.stringify(wsPayload)
    await new Promise<void>((resolve, reject) => {
      ws.send(requestText, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Receive events via a queue
    const eventQueue: Array<
      | { type: 'event'; data: string }
      | { type: 'error'; error: Error }
      | { type: 'done' }
    > = []
    let waiter: ((value: void) => void) | null = null
    let completed = false

    function notify() {
      if (waiter) {
        const w = waiter
        waiter = null
        w()
      }
    }

    const onMessage = (data: WebSocket.RawData) => {
      const text = data.toString()
      eventQueue.push({ type: 'event', data: text })
      notify()
    }

    const onError = (err: Error) => {
      eventQueue.push({ type: 'error', error: err })
      notify()
    }

    const onClose = () => {
      if (!completed) {
        eventQueue.push({ type: 'done' })
        notify()
      }
    }

    const onAbort = () => {
      eventQueue.push({ type: 'error', error: new Error('Request aborted') })
      notify()
    }

    ws.on('message', onMessage)
    ws.on('error', onError)
    ws.on('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })

    // Idle timeout
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        eventQueue.push({
          type: 'error',
          error: new Error('WebSocket idle timeout'),
        })
        notify()
      }, WS_IDLE_TIMEOUT_MS)
    }
    resetIdle()

    try {
      while (true) {
        // Wait for events if queue is empty
        while (eventQueue.length === 0) {
          await new Promise<void>((resolve) => {
            waiter = resolve
          })
        }

        const item = eventQueue.shift()!
        if (item.type === 'done') {
          break
        }
        if (item.type === 'error') {
          throw item.error
        }

        resetIdle()

        // Parse the JSON message — same format as SSE data payloads
        const text = item.data
        let parsed: ResponsesStreamEvent
        try {
          parsed = JSON.parse(text) as ResponsesStreamEvent
        } catch {
          continue // skip malformed
        }

        // Check for wrapped error events (type: "error")
        if (parsed.type === 'error') {
          const errObj = parsed as Record<string, unknown>
          const error = errObj.error as Record<string, unknown> | undefined
          const status = errObj.status as number | undefined
          const msg =
            (error?.message as string) ??
            `WebSocket error (status ${status ?? 'unknown'})`
          throw new Error(msg)
        }

        // Check for response.failed
        if (parsed.type === 'response.failed') {
          const resp = (parsed as Record<string, unknown>).response as
            | Record<string, unknown>
            | undefined
          const error = resp?.error as Record<string, unknown> | undefined
          const msg =
            (error?.message as string) ?? 'OpenAI response.failed'
          throw new Error(msg)
        }

        // Translate to Anthropic events
        const events = translateResponsesEvent(parsed, state)
        for (const event of events) {
          yield event
        }

        // Check if response is complete
        if (
          parsed.type === 'response.completed' ||
          parsed.type === 'response.incomplete'
        ) {
          completed = true
          break
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      ws.off('message', onMessage)
      ws.off('error', onError)
      ws.off('close', onClose)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** Close the connection. */
  cleanup() {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        // ignore
      }
      this.ws = null
    }
    this.closed = true
  }
}
