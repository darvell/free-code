/**
 * SSE stream adapter for the OpenAI Responses API.
 *
 * Parses named SSE events from the Responses API and translates them
 * to Anthropic BetaRawMessageStreamEvent via the translator state machine.
 */

import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  type TranslationState,
  createTranslationState,
  translateResponsesEvent,
} from './translator.js'
import type { ResponsesStreamEvent, ResponseObject } from './types.js'

export class OpenAIStreamAdapter
  implements AsyncIterable<BetaRawMessageStreamEvent>
{
  controller: AbortController
  private state: TranslationState

  constructor(
    private response: Response,
    private model: string,
    signal?: AbortSignal,
  ) {
    this.controller = new AbortController()
    this.state = createTranslationState(model)

    // Relay external abort
    if (signal) {
      signal.addEventListener('abort', () => this.controller.abort(), {
        once: true,
      })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<BetaRawMessageStreamEvent> {
    const body = this.response.body
    if (!body) {
      throw new Error('Response body is null')
    }

    const reader = (body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEventType = ''

    try {
      while (true) {
        if (this.controller.signal.aborted) break

        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Process complete lines
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEventType = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (!data || data === '[DONE]') continue

            try {
              const parsed = JSON.parse(data) as ResponsesStreamEvent
              // Use the event: field type if available, otherwise use the data's type
              if (currentEventType && !parsed.type) {
                ;(parsed as Record<string, unknown>).type = currentEventType
              }

              // Check for failure
              if (
                parsed.type === 'response.failed' &&
                (parsed as { response?: ResponseObject }).response?.error
              ) {
                const error = (parsed as { response: ResponseObject }).response
                  .error!
                throw new Error(
                  `OpenAI API error: ${error.code}: ${error.message}`,
                )
              }

              const events = translateResponsesEvent(parsed, this.state)
              for (const event of events) {
                yield event
              }
            } catch (e) {
              if (
                e instanceof Error &&
                e.message.startsWith('OpenAI API error:')
              ) {
                throw e
              }
              // Skip malformed JSON
            }

            currentEventType = ''
          } else if (line.trim() === '') {
            // Blank line — event boundary; reset event type
            currentEventType = ''
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        const lines = buffer.split('\n')
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (data && data !== '[DONE]') {
              try {
                const parsed = JSON.parse(data) as ResponsesStreamEvent
                const events = translateResponsesEvent(parsed, this.state)
                for (const event of events) {
                  yield event
                }
              } catch {
                // skip
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
}
