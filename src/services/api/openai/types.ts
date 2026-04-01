/**
 * TypeScript types for the OpenAI Responses API.
 *
 * These cover the subset needed by the adapter — not a full SDK.
 * Reference: https://platform.openai.com/docs/api-reference/responses
 */

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

export interface ResponsesApiRequest {
  model: string
  input: ResponseInputItem[]
  instructions?: string
  tools?: ResponsesApiTool[]
  tool_choice?: 'auto' | 'none' | 'required' | ResponsesToolChoiceFunction
  parallel_tool_calls?: boolean
  stream: boolean
  include?: string[]
  reasoning?: ResponsesReasoning
  max_output_tokens?: number
  temperature?: number
  service_tier?: string
  text?: ResponsesTextConfig
  store?: boolean
}

export interface ResponsesToolChoiceFunction {
  type: 'function'
  name: string
}

export interface ResponsesReasoning {
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  summary?: 'auto' | 'concise' | 'detailed'
}

export interface ResponsesTextConfig {
  format?: { type: 'text' } | { type: 'json_object' } | { type: 'json_schema'; json_schema: unknown }
}

export interface ResponsesApiTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

// ---------------------------------------------------------------------------
// Input item types (conversation history sent to the API)
// ---------------------------------------------------------------------------

export type ResponseInputItem =
  | InputMessage
  | InputFunctionCall
  | InputFunctionCallOutput

export interface InputMessage {
  type: 'message'
  role: 'user' | 'assistant' | 'system'
  content: string | InputContentPart[]
}

export interface InputContentPart {
  type: 'input_text' | 'input_image'
  text?: string
  image_url?: string
  detail?: 'auto' | 'low' | 'high'
}

export interface InputFunctionCall {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
}

export interface InputFunctionCallOutput {
  type: 'function_call_output'
  call_id: string
  output: string
}

// ---------------------------------------------------------------------------
// Response object
// ---------------------------------------------------------------------------

export interface ResponseObject {
  id: string
  object: 'response'
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress' | 'cancelled'
  model: string
  output: OutputItem[]
  usage?: ResponseUsage
  error?: { code: string; message: string } | null
  incomplete_details?: { reason: string } | null
}

export interface ResponseUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
}

// ---------------------------------------------------------------------------
// Output items
// ---------------------------------------------------------------------------

export type OutputItem = OutputMessage | OutputFunctionCall | OutputReasoning

export interface OutputMessage {
  type: 'message'
  id: string
  role: 'assistant'
  content: OutputContentPart[]
  status: 'completed' | 'in_progress'
}

export interface OutputContentPart {
  type: 'output_text'
  text: string
  annotations?: unknown[]
}

export interface OutputFunctionCall {
  type: 'function_call'
  id: string
  call_id: string
  name: string
  arguments: string
  status: 'completed' | 'in_progress'
}

export interface OutputReasoning {
  type: 'reasoning'
  id: string
  summary?: OutputContentPart[]
}

// ---------------------------------------------------------------------------
// SSE streaming event types
// ---------------------------------------------------------------------------

export type ResponsesStreamEvent =
  | { type: 'response.created'; response: ResponseObject }
  | { type: 'response.in_progress'; response: ResponseObject }
  | { type: 'response.output_item.added'; output_index: number; item: OutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: OutputItem }
  | { type: 'response.content_part.added'; output_index: number; content_index: number; part: OutputContentPart }
  | { type: 'response.content_part.done'; output_index: number; content_index: number; part: OutputContentPart }
  | { type: 'response.output_text.delta'; output_index: number; content_index: number; delta: string }
  | { type: 'response.output_text.done'; output_index: number; content_index: number; text: string }
  | { type: 'response.function_call_arguments.delta'; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; output_index: number; arguments: string }
  | { type: 'response.reasoning_summary_text.delta'; output_index: number; summary_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.done'; output_index: number; summary_index: number; text: string }
  | { type: 'response.reasoning_summary_part.added'; output_index: number; summary_index: number; part: OutputContentPart }
  | { type: 'response.reasoning_summary_part.done'; output_index: number; summary_index: number; part: OutputContentPart }
  | { type: 'response.completed'; response: ResponseObject }
  | { type: 'response.failed'; response: ResponseObject }
  | { type: 'response.incomplete'; response: ResponseObject }
  | { type: string; [key: string]: unknown } // catch-all for unknown events
