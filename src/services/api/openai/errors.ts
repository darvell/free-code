/**
 * Translate OpenAI HTTP errors into Anthropic SDK APIError instances
 * so the withRetry logic in the codebase works unchanged.
 */

import { APIError } from '@anthropic-ai/sdk/error'

export async function translateOpenAIError(
  response: Response,
): Promise<APIError> {
  let errorMessage: string
  let errorBody: Record<string, unknown> | undefined

  try {
    const body = await response.json()
    errorBody = body as Record<string, unknown>
    const error = errorBody?.error as Record<string, unknown> | undefined
    errorMessage = (error?.message as string) ?? `OpenAI API error: ${response.status}`
  } catch {
    errorMessage = `OpenAI API error: ${response.status}`
  }

  // APIError constructor expects headers with a .get() method (Headers interface).
  // Pass the actual Response.headers which is a proper Headers instance.
  return APIError.generate(
    response.status,
    errorBody ?? { error: { message: errorMessage } },
    errorMessage,
    response.headers,
  )
}
