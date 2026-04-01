/**
 * OpenAI authentication: reads Codex CLI auth.json or OPENAI_API_KEY env var.
 *
 * Priority:
 * 1. OPENAI_API_KEY env var
 * 2. ~/.codex/auth.json (file-based Codex CLI credentials)
 */

import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { getSettings_DEPRECATED } from '../../../utils/settings/settings.js'

const REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const REFRESH_INTERVAL_DAYS = 8

const CHATGPT_BACKEND_URL = 'https://chatgpt.com/backend-api/codex'
const OPENAI_API_URL = 'https://api.openai.com/v1'

export interface OpenAIAuthResult {
  token: string
  baseUrl: string
  accountId?: string
  isChatgptAuth: boolean
}

interface AuthDotJson {
  auth_mode?: 'apikey' | 'chatgpt' | 'chatgptAuthTokens'
  OPENAI_API_KEY?: string
  tokens?: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id?: string
  }
  last_refresh?: string
}

interface RefreshResponse {
  id_token?: string
  access_token?: string
  refresh_token?: string
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex')
}

export function getOpenAIBaseUrl(isChatgptAuth: boolean): string {
  if (process.env.OPENAI_BASE_URL) {
    return process.env.OPENAI_BASE_URL.replace(/\/+$/, '')
  }
  const settings = getSettings_DEPRECATED() || {}
  if ((settings as Record<string, unknown>).openaiBaseUrl) {
    return ((settings as Record<string, unknown>).openaiBaseUrl as string).replace(/\/+$/, '')
  }
  // ChatGPT subscribers use the ChatGPT backend, API key users use the platform API
  return isChatgptAuth ? CHATGPT_BACKEND_URL : OPENAI_API_URL
}

async function readAuthDotJson(): Promise<AuthDotJson | null> {
  const authPath = join(getCodexHome(), 'auth.json')
  try {
    const contents = await readFile(authPath, 'utf-8')
    return JSON.parse(contents) as AuthDotJson
  } catch {
    return null
  }
}

async function saveAuthDotJson(auth: AuthDotJson): Promise<void> {
  const authPath = join(getCodexHome(), 'auth.json')
  await writeFile(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })
}

function needsRefresh(auth: AuthDotJson): boolean {
  if (!auth.last_refresh) return true
  const lastRefresh = new Date(auth.last_refresh)
  const now = new Date()
  const diffDays = (now.getTime() - lastRefresh.getTime()) / (1000 * 60 * 60 * 24)
  return diffDays >= REFRESH_INTERVAL_DAYS
}

function extractAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3) return undefined
    const payload = JSON.parse(
      Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
    )
    return (
      payload?.['https://api.openai.com/auth']?.chatgpt_account_id ?? undefined
    )
  } catch {
    return undefined
  }
}

async function refreshTokens(
  refreshToken: string,
): Promise<RefreshResponse> {
  const endpoint =
    process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE || REFRESH_TOKEN_URL

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Token refresh failed (${response.status}): ${body}. Run "codex login" to re-authenticate.`,
    )
  }

  return (await response.json()) as RefreshResponse
}

export async function getOpenAIAuth(): Promise<OpenAIAuthResult> {
  // Priority 1: OPENAI_API_KEY env var
  const envKey = process.env.OPENAI_API_KEY
  if (envKey) {
    const baseUrl = getOpenAIBaseUrl(false)
    return { token: envKey, baseUrl, isChatgptAuth: false }
  }

  // Priority 2: ~/.codex/auth.json
  const auth = await readAuthDotJson()
  if (!auth) {
    throw new Error(
      'No OpenAI credentials found. Set OPENAI_API_KEY or run "codex login".',
    )
  }

  // API key mode
  if (auth.auth_mode === 'apikey' || (!auth.auth_mode && auth.OPENAI_API_KEY)) {
    if (!auth.OPENAI_API_KEY) {
      throw new Error(
        'auth.json has apikey mode but no OPENAI_API_KEY. Run "codex login".',
      )
    }
    const baseUrl = getOpenAIBaseUrl(false)
    return { token: auth.OPENAI_API_KEY, baseUrl, isChatgptAuth: false }
  }

  // ChatGPT OAuth mode
  if (!auth.tokens?.access_token) {
    throw new Error(
      'auth.json has no access_token. Run "codex login" to re-authenticate.',
    )
  }

  let accessToken = auth.tokens.access_token
  let accountId =
    auth.tokens.account_id || extractAccountId(accessToken)

  // Refresh if needed
  if (needsRefresh(auth) && auth.tokens.refresh_token) {
    try {
      const refreshed = await refreshTokens(auth.tokens.refresh_token)
      if (refreshed.access_token) {
        auth.tokens.access_token = refreshed.access_token
        accessToken = refreshed.access_token
        accountId =
          auth.tokens.account_id || extractAccountId(accessToken)
      }
      if (refreshed.refresh_token) {
        auth.tokens.refresh_token = refreshed.refresh_token
      }
      if (refreshed.id_token) {
        auth.tokens.id_token = refreshed.id_token
      }
      auth.last_refresh = new Date().toISOString()
      await saveAuthDotJson(auth).catch(() => {
        // Non-fatal: tokens work even if we can't persist
      })
    } catch {
      // Use existing token if refresh fails — it may still be valid
    }
  }

  const baseUrl = getOpenAIBaseUrl(true)
  return { token: accessToken, baseUrl, accountId, isChatgptAuth: true }
}

/**
 * Force-refresh the OAuth token after a 401 response.
 * Returns the new auth result or throws.
 */
export async function refreshOpenAIAuthAfter401(): Promise<OpenAIAuthResult> {
  const auth = await readAuthDotJson()
  if (!auth?.tokens?.refresh_token) {
    throw new Error(
      'Cannot refresh: no refresh_token. Run "codex login".',
    )
  }

  const refreshed = await refreshTokens(auth.tokens.refresh_token)
  if (refreshed.access_token) {
    auth.tokens.access_token = refreshed.access_token
  }
  if (refreshed.refresh_token) {
    auth.tokens.refresh_token = refreshed.refresh_token
  }
  if (refreshed.id_token) {
    auth.tokens.id_token = refreshed.id_token
  }
  auth.last_refresh = new Date().toISOString()
  await saveAuthDotJson(auth).catch(() => {})

  const accessToken = auth.tokens.access_token
  const accountId =
    auth.tokens.account_id || extractAccountId(accessToken)
  const baseUrl = getOpenAIBaseUrl(true)

  return { token: accessToken, baseUrl, accountId, isChatgptAuth: true }
}
