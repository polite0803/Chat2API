/**
 * Endpoint 校验策略
 *
 * 绝大多数供应商走 HTTP，endpoint 必须是 http(s)。但走本机运行时的供应商（OpenCode）
 * 不会真的发起 HTTP 请求，它的 endpoint 只是一个占位 scheme，所以不能套这条规则。
 *
 * 判定依据只认内置配置本身（runtimeModels），不接受调用方自报——否则任意自定义
 * 供应商都能借此绕过 endpoint 校验。
 */
import { getBuiltinProvider } from './builtin/index.ts'

export interface EndpointValidation {
  valid: boolean
  errors: string[]
}

/** 这个供应商是否由本机运行时驱动（而不是 HTTP 端点）。 */
export function isRuntimeBackedProvider(
  providerId?: string,
  type?: 'builtin' | 'custom'
): boolean {
  if (type !== 'builtin' || !providerId) return false
  return getBuiltinProvider(providerId)?.runtimeModels === true
}

export function validateApiEndpoint(endpoint: string, allowNonHttp = false): EndpointValidation {
  const errors: string[] = []
  const value = (endpoint ?? '').trim()

  if (!value) {
    errors.push('API endpoint cannot be empty')
    return { valid: false, errors }
  }

  try {
    new URL(value)
  } catch {
    errors.push('Invalid API endpoint format')
  }

  if (allowNonHttp) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      errors.push('Local runtime endpoint must look like <scheme>://<target>')
    }
  } else if (!value.startsWith('http://') && !value.startsWith('https://')) {
    errors.push('API endpoint must start with http:// or https://')
  }

  return { valid: errors.length === 0, errors }
}
