/**
 * 排队等待的**分片计划**（纯函数，无任何 import）。
 *
 * ## 为什么需要"分片"而不只是"封顶"
 *
 * 历史实现把服务端声明的排队延迟**截到 10 秒**（`model-queue.ts` 的
 * `QUEUE_MAX_DELAY_MS`），并在超时后**重发整笔请求**。这条规则本身有依据：
 * 一次阻塞 30 秒会让 UI 长期停在"运行中"，用户分不清"排队"与"卡死"。
 *
 * 但它带来了被反复观测到的代价：服务端回 `retryAfterSeconds: 30` 时，
 * 这条链路会 10 秒重打一次 —— 每一发都是一次**完整的加密请求 + 全量
 * prefill**，三发才过一次，其中两发的 prefill 完全白烧。任务越长越明显。
 *
 * 两种诉求（"单次 sleep 别太长" vs "别反复重打"）并不冲突：
 * **把服务端声明的延迟切成若干 ≤ 单次上限的小片连续睡完，然后只重发一次。**
 *
 * - 单次 sleep 仍 ≤ {@link DEFAULT_QUEUE_SLICE_MS}（默认 10 秒）→ 取消信号与
 *   deadline 检查每片都跑一次，UI 的"可中止"与"卡死判定"不受影响；
 * - 整笔请求只重发一次（而不是 `ceil(30s / 10s)` 次）→ 不再白烧 prefill。
 *
 * ## 本模块是纯的
 *
 * 不读环境变量、不看时钟、不睡 —— 环境与时钟由调用方（`qoder-adapter.ts`）
 * 注入，故切分规则可以被单测逐条钉住（这是唯一能离线验证的部分：排队是
 * 服务端行为，本地无法复现真实队列）。
 */

/** 单次 sleep 的默认上限（毫秒）—— 与历史 `QUEUE_MAX_DELAY_MS` 同值。 */
export const DEFAULT_QUEUE_SLICE_MS = 10_000

/** 服务端**单次声明**延迟可采信的上限（毫秒）。超过则按此值等。 */
export const DEFAULT_QUEUE_MAX_DECLARED_MS = 30_000

/** 拿不到服务端延迟时的保守退避（毫秒）。 */
export const DEFAULT_QUEUE_FALLBACK_MS = 1_000

/**
 * 单片的**下限**（毫秒）。
 *
 * 服务端回 `0`（"立即可用"但网关仍按排队通道下发）时若真的不睡，会变成
 * 忙循环，把 180 次尝试在几毫秒内烧完。故保留一个极短间隔。
 */
export const MIN_QUEUE_SLICE_MS = 100

/** 分片参数。 */
export interface QueueWaitConfig {
  /** 单次 sleep 上限；`<= 0` 表示不切分（整段一次睡完，仅排查时用）。 */
  sliceMs: number
  /** 服务端单次声明延迟的采信上限。 */
  maxDeclaredMs: number
  /** 无服务端延迟时的退避。 */
  fallbackMs: number
  /** 单片下限，默认 {@link MIN_QUEUE_SLICE_MS}。 */
  minSliceMs?: number
}

/** 读有限非负数字；非法值一律按"没给"处理（`NaN` / 负数 / 非数字）。 */
function finiteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 算出本次排队该睡哪几片。
 *
 * 规则（顺序即优先级）：
 * 1. 没有服务端延迟（`undefined` / 非有限 / 负）→ 一片 {@link DEFAULT_QUEUE_FALLBACK_MS}
 *    （客户端 `W7c()` 此时同样退回退避，不忙等）；
 * 2. 延迟为 `0` → 一片 `minSliceMs`（不忙等）；
 * 3. 其余 → 先按 `maxDeclaredMs` 截断，再按 `sliceMs` 切片；**尾片过短时并入
 *    前一片**，避免出现 `9999 + 1(ms)` 这种无意义的碎片。
 *
 * ⚠️ 所有切片之和**不超过** `min(declared, maxDeclaredMs)`，且每片 `>= minSliceMs`。
 * 调用方负责剩余总预算（deadline）与取消信号的检查 —— 本函数只回答"睡多久"。
 *
 * @param declaredMs - 服务端声明的延迟（`retry_after_ms` / `retryAfterMs` /
 *   `retryAfterSeconds × 1000` 的解析结果，由 `model-queue.ts` 产出）。
 * @param config - 见 {@link QueueWaitConfig}。
 * @returns 毫米级切片数组；**不会为空**（至少一片）。
 */
export function planQueueWait(
  declaredMs: number | undefined,
  config: QueueWaitConfig,
): number[] {
  const minSlice = Math.max(1, Math.trunc(finiteOrUndefined(config.minSliceMs) ?? MIN_QUEUE_SLICE_MS))
  const fallback = Math.max(minSlice, Math.trunc(finiteOrUndefined(config.fallbackMs) ?? DEFAULT_QUEUE_FALLBACK_MS))
  const maxDeclared = Math.max(minSlice, Math.trunc(finiteOrUndefined(config.maxDeclaredMs) ?? DEFAULT_QUEUE_MAX_DECLARED_MS))
  const sliceMs = Math.trunc(finiteOrUndefined(config.sliceMs) ?? DEFAULT_QUEUE_SLICE_MS)

  const declared = finiteOrUndefined(declaredMs)
  if (declared === undefined) return [fallback]
  if (declared === 0) return [minSlice]

  const total = Math.min(Math.max(declared, minSlice), maxDeclared)
  // `sliceMs <= 0` = 不切分：整段一次睡完（排查用；UI 可中止性由调用方承担）。
  if (sliceMs <= 0 || sliceMs >= total) return [total]

  const slices: number[] = []
  let remaining = total
  while (remaining > 0) {
    let slice = Math.min(remaining, sliceMs)
    // 尾片过短 → 并入本片，避免 10000 + 1 这种碎片。
    const rest = remaining - slice
    if (rest > 0 && rest < minSlice) slice = remaining
    slices.push(slice)
    remaining -= slice
  }
  return slices
}

/** 切片之和（调用方记日志/断言用）。 */
export function totalQueueWaitMs(slices: readonly number[]): number {
  return slices.reduce((sum, value) => sum + value, 0)
}
