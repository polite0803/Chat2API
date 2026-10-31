/**
 * Raccoon 上游**频率超限**错误的识别与冷却参数（纯函数，零 import）。
 *
 * 独立成模块的原因同 `account-balance-gate.ts` / `queue-wait.ts`：
 * 判据必须能被 `node --test` 直接以 TS 源加载做真实单测
 *（raccoon-adapter.ts 拖着整条 LLM 契约依赖链，拉不动）。
 *
 * ## 背景（2026-10-31 用户报障）
 *
 * 实测 raccoon 网关把限流包在 **HTTP 5xx** 里下发（正文
 * `{"error":{"message":"您的模型请求频率超限，请稍后重试",…}}`）。
 * 适配器原按 `httpErrorCode(5xx)` 归成 `SERVER` → 客户端看到 502，把
 * **确定性限流**当可重试故障立即硬重试（实测 4 分钟 15 连撞），
 * 且不换号不标记，同一账号被撞到底。
 */

/** 频率超限的短冷却时长（「请稍后重试」语义，分钟级）。 */
export const RACCOON_RATE_LIMIT_COOLDOWN_MS = 60_000

/**
 * 判定一次 raccoon 上游失败是否为频率超限。
 *
 * 判据刻意窄：HTTP 429，或正文含明确的频率/限流文案。不用共享
 * `rate-limit.ts` 的宽 pattern（其中「重置」等词过泛，会误伤无关错误，
 * 让账号被错误地挂上冷却标记）。
 */
export function isRaccoonRateLimitError(status: number, body: string): boolean {
  if (status === 429) return true
  return /频率超限|请求频率|请求过于频繁|rate.?limit|too many requests/i.test(body)
}
