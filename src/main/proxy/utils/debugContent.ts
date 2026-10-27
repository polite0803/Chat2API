let enabled = false

export function setContentLoggingEnabled(value: boolean): void {
  enabled = value
}

/**
 * Logs conversation payloads (user input and model output) to stdout.
 * Follows the request-log "include bodies" switch, which is off by default,
 * so chat content never reaches the terminal or a packaged app's stdout unless
 * the user asked for body logging.
 */
export function debugContent(tag: string, value: unknown, limit = 200): void {
  if (!enabled) return
  const text =
    typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value)
  console.log(tag, text.length > limit ? `${text.slice(0, limit)}...` : text)
}
