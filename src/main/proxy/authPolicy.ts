import { createHash, timingSafeEqual } from 'crypto'

export interface ApiKeyRecord {
  key: string
  enabled: boolean
}

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const

const LOOPBACK_HEADERS = 'Content-Type, Authorization, X-Requested-With, X-API-Key, X-Management-Secret'

export function isLoopbackHost(host?: string): boolean {
  if (!host) return false
  return (LOOPBACK_HOSTS as readonly string[]).includes(host)
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin)
    return isLoopbackHost(hostname) || hostname === '[::1]'
  } catch {
    return false
  }
}

export function safeKeyEquals(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

export function activeApiKeys(apiKeys?: ApiKeyRecord[]): ApiKeyRecord[] {
  return (apiKeys ?? []).filter((entry) => entry.enabled && typeof entry.key === 'string' && entry.key.length > 0)
}

export function requiresApiKey(apiKeys?: ApiKeyRecord[]): boolean {
  return activeApiKeys(apiKeys).length > 0
}

export type ApiKeyAuthOutcome = 'allow' | 'missing_key' | 'invalid_key'

export function evaluateApiKeyAuth(input: {
  apiKeys?: ApiKeyRecord[]
  providedKey?: string | null
}): ApiKeyAuthOutcome {
  const keys = activeApiKeys(input.apiKeys)
  if (keys.length === 0) return 'allow'
  if (!input.providedKey) return 'missing_key'
  return keys.some((entry) => safeKeyEquals(entry.key, input.providedKey as string)) ? 'allow' : 'invalid_key'
}

export function checkStartupSecurity(input: { apiKeys?: ApiKeyRecord[]; host: string }): { ok: boolean; reason?: string } {
  if (requiresApiKey(input.apiKeys)) return { ok: true }
  if (isLoopbackHost(input.host)) return { ok: true }
  return { ok: false, reason: 'api_key_required_for_non_loopback_listen' }
}

export function resolveCorsOrigin(input: {
  origin?: string
  requiresKey: boolean
  host: string
}): string | null {
  if (!input.requiresKey && isLoopbackHost(input.host)) return '*'
  if (input.origin && isLoopbackOrigin(input.origin)) return input.origin
  return null
}

export function corsAllowHeaders(): string {
  return LOOPBACK_HEADERS
}
