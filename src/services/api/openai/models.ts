/**
 * Fetches the available OpenAI/Codex model list from the /models endpoint
 * and returns them as ModelOption[] for the model picker.
 */

import type { OpenAIAuthResult } from './auth.js'

interface CodexModelInfo {
  slug: string
  display_name: string
  description?: string
  priority: number
  visibility: string
  supported_in_api: boolean
  supported_reasoning_levels?: Array<{
    effort: string
    description: string
  }>
  context_window?: number
}

interface ModelsResponse {
  models: CodexModelInfo[]
}

export interface OpenAIModelOption {
  value: string
  label: string
  description: string
}

export async function fetchOpenAIModels(
  auth: OpenAIAuthResult,
): Promise<OpenAIModelOption[]> {
  const baseUrl = auth.baseUrl.replace(/\/+$/, '')
  const modelsUrl = `${baseUrl}/models?client_version=0.117.0`

  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
        ...(auth.accountId
          ? { 'ChatGPT-Account-Id': auth.accountId }
          : {}),
      },
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      return []
    }

    const data = (await response.json()) as ModelsResponse
    if (!data.models || !Array.isArray(data.models)) {
      return []
    }

    return data.models
      .filter(
        (m) =>
          m.visibility === 'list' &&
          // Filter out Claude models — those are already in the picker natively
          !m.slug.startsWith('opus') &&
          !m.slug.startsWith('sonnet') &&
          !m.slug.startsWith('haiku') &&
          !m.slug.startsWith('claude'),
      )
      .sort((a, b) => a.priority - b.priority)
      .map((m) => {
        const efforts = m.supported_reasoning_levels
          ?.map((r) => r.effort)
          .join('/')
        const ctx = m.context_window
          ? `${Math.round(m.context_window / 1000)}k`
          : ''
        const parts = [
          m.description || '',
          efforts ? `Reasoning: ${efforts}` : '',
          ctx ? `${ctx} context` : '',
        ].filter(Boolean)

        return {
          value: m.slug,
          label: m.display_name || m.slug,
          description: parts.join(' · ') || m.slug,
        }
      })
  } catch {
    return []
  }
}
