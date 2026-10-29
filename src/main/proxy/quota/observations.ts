/**
 * 从上游已经发回来的东西里读出真实上限。
 *
 * 这不是主动探测：只在用户自己的正常请求（成功或 429）返回时顺带读一次响应头与错误体。
 * 读出来的值一律走 `learned` 通道，由 `limits.resolveCaps` 以「只填空、只下调」的方式合并——
 * 上游谎报或口径不同最多让我们提前避开一家，不会把官方帽抬高。
 */

import type { QuotaMetric } from './limits.ts'

export interface LearnedCap {
  metric: QuotaMetric
  limit: number
  /** header = 响应头，最硬；error_body = 从 429 文本反解 */
  source: 'header' | 'error_body'
}

type HeaderValue = string | number | string[] | undefined

function firstHeader(headers: Record<string, HeaderValue> | undefined, name: string): string | null {
  if (!headers) return null
  const key = Object.keys(headers).find(k => k.toLowerCase() === name)
  if (!key) return null
  const value = headers[key]
  const raw = Array.isArray(value) ? value[0] : value
  return raw === undefined ? null : String(raw)
}

function positiveInt(raw: string | null): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[,\s]/g, '')
  if (!/^\d+$/.test(cleaned)) return null
  const value = Number(cleaned)
  return value > 0 ? value : null
}

/**
 * 各家额度头的轴与窗口。只列**我们自己核对过形状**的两种通用写法与 cerebras 的日/分差异；
 * 认不出来就不学，宁缺毋滥——把 requests 帽当成 tokens 帽会让预检提前拒掉好候选。
 */
const HEADER_AXES: Array<{ limit: string; metric: QuotaMetric }> = [
  { limit: 'x-ratelimit-limit-requests', metric: 'rpm' },
  { limit: 'x-ratelimit-limit-tokens', metric: 'tpm' },
  { limit: 'x-ratelimit-limit-requests-day', metric: 'rpd' },
  { limit: 'x-ratelimit-limit-tokens-day', metric: 'tpd' },
  { limit: 'x-ratelimit-limit-requests-minute', metric: 'rpm' },
  { limit: 'x-ratelimit-limit-tokens-minute', metric: 'tpm' },
]

export function learnFromHeaders(headers: Record<string, HeaderValue> | undefined): LearnedCap[] {
  const caps: LearnedCap[] = []
  for (const axis of HEADER_AXES) {
    const limit = positiveInt(firstHeader(headers, axis.limit))
    if (limit !== null) caps.push({ metric: axis.metric, limit, source: 'header' })
  }
  return caps
}

/**
 * 429 文本里的 `limit: N` 与轴关键词。轴按"越具体越先"排：
 * 日 token > 输出 token > 输入 token > 分钟 token > 日请求 > 分钟请求。
 * 排错轴会把分钟帽写成日帽，预检直接废掉，所以宁可一条都不认。
 */
const AXIS_PATTERNS: Array<{ metric: QuotaMetric; test: RegExp }> = [
  { metric: 'tpd', test: /tokens?\s+(?:per\s+day|\/\s*day|daily)|\btpd\b/i },
  { metric: 'rpd', test: /requests?\s+(?:per\s+day|\/\s*day|daily)|\brpd\b/i },
  { metric: 'tpm', test: /tokens?\s+(?:per\s+min(?:ute)?|\/\s*min(?:ute)?)|\btpm\b/i },
  { metric: 'rpm', test: /requests?\s+(?:per\s+min(?:ute)?|\/\s*min(?:ute)?)|\brpm\b/i },
]

const LIMIT_NUMBER = /limit[:\s]+([\d,]+)/i

export function learnFromErrorBody(text: string | undefined): LearnedCap[] {
  if (!text) return []
  const match = LIMIT_NUMBER.exec(text)
  if (!match) return []
  const limit = positiveInt(match[1])
  if (limit === null) return []

  for (const axis of AXIS_PATTERNS) {
    if (axis.test.test(text)) {
      return [{ metric: axis.metric, limit, source: 'error_body' }]
    }
  }
  // 认不出轴就不学：把分钟帽写成日帽会让预检整天提前拒掉一个本来能用的供应商。
  return []
}

/** Retry-After 只作为"最早可再试"的秒数下界，不当成额度。 */
export function retryAfterSeconds(headers: Record<string, HeaderValue> | undefined): number | null {
  const raw = firstHeader(headers, 'retry-after')
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}
