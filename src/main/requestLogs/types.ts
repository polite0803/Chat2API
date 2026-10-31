import type { RequestLogConfig } from '../store/types.ts'

export type { RequestLogConfig } from '../store/types.ts'

export interface RequestLogFilter {
  status?: 'success' | 'error'
  providerId?: string
}

export interface RequestLogStats {
  total: number
  success: number
  error: number
  todayTotal: number
  todaySuccess: number
  todayError: number
}

/**
 * 请求体截断上限的默认值（用户要求 2026-10-30 从 8000 调大）：排查流内错误帧、
 * 工具调用改写这类问题时 8000 字符只够看到头部与第一条消息（真实请求体实测
 * 1.8MB，见 `toolCallValidation` 头注释）。20 万这个量级既装下绝大多数请求体，
 * 又不至于让每条日志膨胀到几百 MB。
 */
export const DEFAULT_MAX_BODY_CHARS = 200_000

/** 旧版默认值：升级迁移用它识别「用户从未自定义」的存量配置。 */
const LEGACY_MAX_BODY_CHARS = 8000

export function normalizeRequestLogConfig(config?: Partial<RequestLogConfig>): RequestLogConfig {
  const normalized = {
    enabled: true,
    maxEntries: 200,
    includeBodies: false,
    maxBodyChars: DEFAULT_MAX_BODY_CHARS,
    redactSensitiveData: true,
    ...config,
  }
  // 存量配置里仍停留在旧默认值的 maxBodyChars 视为「从未自定义」，随升级提到
  // 新默认 —— 否则改默认值对老用户永远不生效（store 里早已落盘 8000）。
  // 主动改过值的用户不受影响。
  if (normalized.maxBodyChars === LEGACY_MAX_BODY_CHARS) {
    normalized.maxBodyChars = DEFAULT_MAX_BODY_CHARS
  }
  return normalized
}
