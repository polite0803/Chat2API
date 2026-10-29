import type { RequestLogEntry } from '../store/types.ts'
import type { RequestLogConfig } from './types.ts'

export function sanitizeRequestLogEntry(
  entry: Omit<RequestLogEntry, 'id'>,
  config: RequestLogConfig,
): Omit<RequestLogEntry, 'id'> {
  const sanitized: Omit<RequestLogEntry, 'id'> = {
    ...entry,
    userInput: truncateText(entry.userInput, 500),
    errorStack: undefined,
  }

  if (!config.includeBodies) {
    sanitized.requestBody = undefined
    sanitized.responseBody = undefined
    sanitized.responsePreview = truncateText(entry.responsePreview, 1000)
    sanitized.errorMessage = truncateText(entry.errorMessage, 1000)
    return sanitized
  }

  sanitized.requestBody = sanitizeRequestLogBody(entry.requestBody, config)
  sanitized.responseBody = sanitizeRequestLogBody(entry.responseBody, config)
  sanitized.responsePreview = truncateText(entry.responsePreview, 1000)
  sanitized.errorMessage = truncateText(entry.errorMessage, 1000)

  return sanitized
}

/**
 * An update is a partial patch, so only the keys it actually carries may be
 * re-sanitized. Deriving every field from `updates` (as this used to) writes
 * `undefined` over fields the patch never mentioned - a stream-end update that
 * only has the response body would erase the user input recorded at insert.
 */
export function sanitizeRequestLogUpdates(
  updates: Partial<RequestLogEntry>,
  config: RequestLogConfig,
): Partial<RequestLogEntry> {
  const sanitized: Partial<RequestLogEntry> = { ...updates }

  if ('userInput' in updates) {
    sanitized.userInput = truncateText(updates.userInput, 500)
  }

  if ('errorStack' in updates) {
    sanitized.errorStack = undefined
  }

  if ('requestBody' in updates) {
    sanitized.requestBody = config.includeBodies
      ? sanitizeRequestLogBody(updates.requestBody, config)
      : undefined
  }

  if ('responseBody' in updates) {
    sanitized.responseBody = config.includeBodies
      ? sanitizeRequestLogBody(updates.responseBody, config)
      : undefined
  }

  if ('responsePreview' in updates) {
    sanitized.responsePreview = truncateText(updates.responsePreview, 1000)
  }

  if ('errorMessage' in updates) {
    sanitized.errorMessage = truncateText(updates.errorMessage, 1000)
  }

  return sanitized
}

export function trimRequestLogsToMaxEntries(
  entries: RequestLogEntry[],
  config: RequestLogConfig,
): RequestLogEntry[] {
  const maxEntries = Math.max(0, config.maxEntries)
  if (maxEntries === 0) {
    return []
  }

  if (entries.length <= maxEntries) {
    return entries
  }

  return entries.slice(entries.length - maxEntries)
}

function sanitizeRequestLogBody(value: string | undefined, config: RequestLogConfig): string | undefined {
  if (!value) return value

  const redacted = config.redactSensitiveData ? redactSensitiveText(value) : value
  return truncateText(redacted, config.maxBodyChars)
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return value
  if (maxChars <= 0) return undefined
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...[truncated ${value.length - maxChars} chars]`
}

function redactSensitiveText(value: string): string {
  return value.replace(
    /(\"?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set-cookie|password|token)\"?\s*[:=]\s*)\"?[^\",}\]\s]+\"?/gi,
    '$1"[REDACTED]"',
  )
}
