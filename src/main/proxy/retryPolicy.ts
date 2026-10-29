import type { ProviderType } from '../store/types'

/**
 * 转发层重试预算的**唯一决策点**（纯函数，可脱离 electron 与网络单测）。
 *
 * ## 为什么按 provider 分类，而不是全局一套
 *
 * 旧实现在这里对所有 provider 一视同仁：失败后 `await delay(5000)`，最多
 * `config.retryCount`（默认 3）次。对内建 / 聚合端点这是合理的 —— 它们的
 * 重试语义就归本进程管。但**账号渠道不是**：上游协议、排队、额度与换号的
 * 重试全部在渠道 Worker 里（见 `forwarder.forwardAccountChannel` 的模块注释
 * 与 `vendor/channel-pack/src/qoder-adapter.ts` 的 `retryQueuedRequest` /
 * `retryUpstreamTimeout`）。宿主在此之上再叠一层，得到的是**双重退避**：
 *
 * | 层 | 旧预算 |
 * |---|---|
 * | 渠道内 504 首字超时 | 2s + 8s（已实测与官方 0.5s 的差异并刻意放宽） |
 * | 渠道内排队 10605 | 服务端声明值，单次 ≤ 10s，总预算 30 分钟 |
 * | 宿主 5xx | **每次 5s × 3** |
 *
 * 而账号渠道的一发失败请求不是免费的：它重新解析凭据（跨线程取 safeStorage
 * 解密）、重新用 WASM 加密**整个历史**、再打一次上游。用户体感就是「同一个
 * 提示转很久」。
 *
 * ## 为什么不干脆取消账号渠道的重试
 *
 * 渠道自己**不覆盖**两类瞬时故障：worker 刚崩溃重启、以及 `TRANSPORT`
 * （连接被重置）。这两类只能由宿主重发一次才有救。所以是**降到一次 + 短退避**，
 * 不是清零 —— 清零会把可自愈的故障变成必然失败，那是矫枉过正。
 *
 * ## 调用方显式给的预算优先
 *
 * `forwardAutoCompletion` 之类的路径会传 `{ maxRetries: 0 }`（候选链上每个
 * 供应商只打一次，失败就换下一个）。那是一句**指令**，不是一句默认值：本函数
 * 只会**下调**、绝不上调，`0` 永远得到 `0`。
 */

/** 非账号渠道的重试间隔（毫秒）—— 历史值，保持不变。 */
export const DEFAULT_FORWARD_RETRY_DELAY_MS = 5_000

/**
 * 账号渠道的重试间隔（毫秒）。
 *
 * 取 500ms 而不是 0：`TRANSPORT` 类故障（连接重置、worker 刚重建）在同一毫秒
 * 重打往往仍然失败；也不是 5s：那一档已经被渠道内部退避覆盖，宿主再等 5 秒
 * 只是把用户体感的等待累加，而不是把成功率提高。
 */
export const ACCOUNT_CHANNEL_RETRY_DELAY_MS = 500

/** 账号渠道在宿主层最多**额外**尝试几次。 */
export const ACCOUNT_CHANNEL_MAX_RETRIES = 1

/** 一次转发重试的预算（次数不含首次尝试）。 */
export interface ForwardRetryProfile {
  /** 额外重试次数；`0` = 只打一次（此时宿主不会睡任何一秒）。 */
  maxRetries: number
  /** 每次重试前的等待（毫秒）。 */
  retryDelayMs: number
}

/** 读成非负整数；非法值（`NaN` / 负数 / 非数字）按 **0** 处理，而不是按默认。 */
function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0
}

/**
 * 算出某次转发该重试几次、每次等多久。
 *
 * @param type - provider 类型（只需类型字段，不要求整条记录）。
 * @param configuredRetries - 调用方给的预算：`options.maxRetries ?? config.retryCount`。
 *   **只下调不上调**：显式的 `0` 得到 `0`。
 */
export function planForwardRetries(
  type: ProviderType,
  configuredRetries: number,
): ForwardRetryProfile {
  const budget = toCount(configuredRetries)
  if (type === 'account') {
    return {
      maxRetries: Math.min(budget, ACCOUNT_CHANNEL_MAX_RETRIES),
      retryDelayMs: ACCOUNT_CHANNEL_RETRY_DELAY_MS,
    }
  }
  return { maxRetries: budget, retryDelayMs: DEFAULT_FORWARD_RETRY_DELAY_MS }
}
