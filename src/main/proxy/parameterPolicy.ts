import type { ChatCompletionRequest } from './types'

const REJECTED_FOR_BUILTIN = [
  'response_format',
  'stream_options',
  'logit_bias',
  'seed',
  'top_p',
  'stop',
  'frequency_penalty',
  'presence_penalty',
  'max_tokens',
] as const

export function findUnsupportedParameter(
  request: ChatCompletionRequest,
  provider: { type?: string }
): string | null {
  if (provider.type !== 'builtin') return null

  const raw = request as ChatCompletionRequest & Record<string, unknown>

  if (raw.response_format !== undefined && raw.response_format !== null) {
    const format = raw.response_format
    const formatType = typeof format === 'string' ? format : (format as { type?: string })?.type
    if (formatType !== 'text') {
      return 'response_format'
    }
  }

  for (const name of REJECTED_FOR_BUILTIN) {
    if (name === 'response_format') continue
    if (raw[name] !== undefined && raw[name] !== null) return name
  }

  if (typeof request.n === 'number' && request.n > 1) return 'n'

  return null
}

export function unsupportedParameterError(param: string) {
  return {
    error: {
      message: `Parameter "${param}" is not supported by built-in providers`,
      type: 'invalid_request_error',
      param,
      code: 'unsupported_parameter',
    },
  }
}
