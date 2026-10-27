export interface UpstreamErrorShape {
  status: number
  type: string
  code: string | null
}

export function mapUpstreamError(status?: number): UpstreamErrorShape {
  if (status === 401 || status === 403) {
    return { status: 401, type: 'authentication_error', code: 'upstream_unauthorized' }
  }
  if (status === 429) {
    return { status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded' }
  }
  if (status && status >= 400 && status < 500) {
    return { status, type: 'invalid_request_error', code: null }
  }
  if (status && status >= 500) {
    return { status, type: 'api_error', code: null }
  }
  return { status: 500, type: 'api_error', code: null }
}

export function buildStreamErrorFrame(message: string): string {
  return `data: ${JSON.stringify({
    error: {
      message,
      type: 'api_error',
      code: null,
    },
  })}\n\n`
}

export function retryAfterHeader(headers?: Record<string, unknown>): string | undefined {
  if (!headers) return undefined
  const value = headers['retry-after'] ?? headers['Retry-After']
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text || undefined
}
