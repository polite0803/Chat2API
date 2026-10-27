/**
 * Model List Request Builder
 * Pure request-side helpers for the online model list fetch, kept free of
 * electron and axios imports so they can be tested without booting the app.
 */

import type { ModelsFetchAuthRule } from '../../shared/types'

const UUID_PLACEHOLDER = '{uuid}'

export type AuthHeadersResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; missingFields: string[] }

/**
 * Some providers key their list on a client-generated install id, so the
 * request carries a fresh uuid instead of a stored one.
 */
export function buildRequestUrl(url: string, uuid: string): string {
  return url.split(UUID_PLACEHOLDER).join(uuid)
}

export function buildRequestBody(
  body: Record<string, unknown> | undefined,
  uuid: string
): Record<string, unknown> {
  if (!body) return {}
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.split(UUID_PLACEHOLDER).join(uuid) : value,
    ])
  )
}

/**
 * Turn the active account's credentials into request headers, following the provider's
 * declared rules. Every rule has to resolve: a partial cookie set is rejected here rather
 * than sent, because the provider would answer 401 and that looks like a different failure.
 * Rules apply in order and the first writer wins, so a later rule cannot overwrite a cookie or header
 * an earlier rule already set.
 */
export function buildAuthHeaders(
  rules: ModelsFetchAuthRule[] | undefined,
  credentials: Record<string, unknown> | undefined
): AuthHeadersResult {
  if (!rules || rules.length === 0) return { ok: true, headers: {} }

  const headers: Record<string, string> = {}
  const cookies: Record<string, string> = {}
  const seenCookie = new Set<string>()
  const missingFields: string[] = []

  for (const rule of rules) {
    const value = credentials ? credentials[rule.from] : undefined

    if (typeof value !== 'string' || value.trim() === '') {
      missingFields.push(rule.from)
      continue
    }

    if (rule.into === 'cookie') {
      const name = rule.cookie
      if (!name || seenCookie.has(name)) continue
      seenCookie.add(name)
      cookies[name] = value.trim()
      continue
    }

    if (rule.header) headers[rule.header] = `${rule.prefix ?? ''}${value.trim()}`
  }

  const cookieNames = Object.keys(cookies)
  if (cookieNames.length > 0) {
    headers.Cookie = cookieNames.map(name => `${name}=${cookies[name]}`).join('; ')
  }

  if (missingFields.length > 0) return { ok: false, missingFields }

  return { ok: true, headers }
}
