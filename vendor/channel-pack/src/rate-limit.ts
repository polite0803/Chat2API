/** 渠道共用的限流识别、重置时刻解析与等待时间格式化。 */
export function formatResetIn(resetAtMs: number, nowMs: number = Date.now()): string {
  const diff = resetAtMs - nowMs
  if (diff <= 0) return '即将重置'
  if (diff < 60_000) return '不到 1 分钟'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟`
  // 保留一位小数：额度按自然日结算，剩余时间通常在 1~24 小时之间，
  // 只报整数会让「还有 1 小时」与「还有 1.9 小时」看起来一样。
  return `${Math.round(diff / 360_000) / 10} 小时`
}

const RATE_LIMIT_PATTERN =
  /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i

export function isRateLimited(body: string, status?: number): boolean {
  if (status === 429) return true
  return RATE_LIMIT_PATTERN.test(body)
}

const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i

/**
 * 腾讯系「模型饱和」业务码（上游背压），与账号级额度限流 `6004` **语义相反**：
 * 6004 换号有效且必须标记；14003 换号无益、**不许**标记（否则整池锁一小时）。
 */
export const MODEL_SATURATION_BUSINESS_CODE = 14003

/** 模型饱和的文案兜底；关键词必须窄，且调用方要求 HTTP 状态 ≥ 400 才看文案。 */
const MODEL_SATURATION_PATTERN = /模型繁忙|请求量饱和|model\s+busy|currently\s+saturated/i

/**
 * 判断一次失败是否为**模型饱和**（上游背压），而不是账号级额度限流。
 *
 * ⚠️ 必须在 `status === 429` 的无条件判定**之前**调用：14003 恰好是 429，
 * 先判状态码就永远走不到这里。
 */
export function isModelSaturationError(status: number | undefined, body: string): boolean {
  if (typeof status === 'number' && status < 400) return false
  if (body.length === 0) return false
  try {
    const code = (JSON.parse(body) as Record<string, unknown>).code
    if (code === MODEL_SATURATION_BUSINESS_CODE
      || code === String(MODEL_SATURATION_BUSINESS_CODE)) return true
  } catch {
    // 非 JSON：交给文案兜底。
  }
  return MODEL_SATURATION_PATTERN.test(body)
}

export const RATE_LIMIT_FALLBACK_MS = 3_600_000

export function parseRateLimitError(
  body: string,
  currentModel: string,
  status?: number,
): { modelId: string; resetTimeMs: number } | null {
  const fallback = (): { modelId: string; resetTimeMs: number } => ({
    modelId: currentModel,
    resetTimeMs: Date.now() + RATE_LIMIT_FALLBACK_MS,
  })
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const msg = typeof data.msg === 'string' ? data.msg : ''
    const resetMatch = RESET_TIME_PATTERN.exec(msg)
    if (resetMatch) {
      // 用捕获到的真实时区拼接（不再写死 UTC+8），Date.parse 能正确解析该写法。
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`)
      if (!Number.isNaN(resetMs)) {
        return { modelId: currentModel, resetTimeMs: resetMs }
      }
    }
    // 标准 OpenAI 429 格式，或带业务码但文案无法解析出时间
    if (isRateLimited(body, status)) {
      return fallback()
    }
    return null
  } catch {
    // 非 JSON（空体、纯文本、CDN 的 HTML 错误页）：只剩状态码可判。
    return status === 429 ? fallback() : null
  }
}
