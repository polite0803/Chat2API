/**
 * Bandit 实时评分（PLAN-auto-routing-freellmapi P2-5 第一步，静态权重先行）。
 *
 * 数据源是 request-logs.ndjson 的内存副本：按 `(providerId, actualModel)` 滚动
 * 24h 统计成功率与延迟 p50，作为 auto 打分的加减分因子，替换"候选只能靠静态
 * 启发式排序"的盲区。Thompson sampling 留给观察后的第二步。
 *
 * 设计约束：
 * - **纯函数**：与 autoRouting.ts 同一纪律，node --test 直测，不碰 electron；
 * - **冷启动乐观先验**：无样本或样本过少（< 5 笔）不调整 —— 新账号/新模型
 *   不会被统计空窗永远压住，轮不到就没有数据、没数据就永远轮不到；
 * - **口径诚实**：日志里没有 TTFT 字段，速度用整笔 latency 的 p50 近似
 *   （流式请求含生成时长，噪声大，所以只对显著慢的候选轻惩罚）。
 */

/** 参与 Bandit 统计的日志最小切片（RequestLogEntry 的相关字段）。 */
export interface BanditLogEntry {
  timestamp: number
  status: 'success' | 'error'
  latency: number
  providerId?: string
  actualModel?: string
}

/** 一个 (provider, model) 的滚动窗口战绩。 */
export interface BanditStats {
  total: number
  successes: number
  latencyP50Ms?: number
}

/** 默认统计窗口：24 小时（与 PLAN 的滚动 24h 口径一致）。 */
export const BANDIT_WINDOW_MS = 24 * 60 * 60_000

/** 样本量下限：低于它的键不参与调整（乐观先验，见模块头注释）。 */
export const BANDIT_MIN_SAMPLES = 5

/** Bandit 表的键：与请求日志里的 (providerId, actualModel) 同形。 */
export function banditKeyOf(providerId: string, actualModel: string): string {
  return `${providerId}|${actualModel}`
}

/** p50：偶数样本取中间两数的均值（与常规中位数定义一致）。 */
export function latencyP50(latenciesMs: number[]): number | undefined {
  if (latenciesMs.length === 0) return undefined
  const sorted = [...latenciesMs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * 把请求日志折成 Bandit 表：单遍扫描，只保留窗口内的记录。
 * `providerId`/`actualModel` 缺失的条目无法归因，直接跳过。
 */
export function aggregateBanditStats(
  entries: readonly BanditLogEntry[],
  nowMs: number,
  windowMs: number = BANDIT_WINDOW_MS
): Map<string, BanditStats> {
  const from = nowMs - windowMs
  const latencies = new Map<string, number[]>()
  const table = new Map<string, BanditStats>()

  for (const entry of entries) {
    if (entry.timestamp < from || entry.timestamp > nowMs) continue
    if (!entry.providerId || !entry.actualModel) continue

    const key = banditKeyOf(entry.providerId, entry.actualModel)
    const stats = table.get(key) ?? { total: 0, successes: 0 }
    stats.total += 1
    if (entry.status === 'success') stats.successes += 1
    table.set(key, stats)

    if (typeof entry.latency === 'number' && entry.latency >= 0) {
      const bucket = latencies.get(key) ?? []
      bucket.push(entry.latency)
      latencies.set(key, bucket)
    }
  }

  for (const [key, bucket] of latencies) {
    const p50 = latencyP50(bucket)
    if (p50 !== undefined) {
      const stats = table.get(key)
      if (stats) stats.latencyP50Ms = p50
    }
  }

  return table
}

/** 显著慢的门槛：p50 超过它的候选轻惩罚（噪声大，只罚显著的）。 */
const SLOW_P50_MS = 30_000

/**
 * Bandit 加减分（进 auto 打分的总分，量级与 uncertainTools 扣分同级）：
 * - 无数据 / 样本 < 5 → 0（乐观先验，见模块头）；
 * - 成功率 1.0 → +0.075，0.5 → 0，0 → -0.075：够把长期失败的候选压下去，
 *   又不至于一两次失败就把候选踢出前排；
 * - p50 显著慢（> 30s）再扣 0.05。
 */
export function banditAdjustment(stats: BanditStats | undefined): number {
  if (stats === undefined || stats.total < BANDIT_MIN_SAMPLES) return 0

  const successRate = stats.successes / stats.total
  let adjustment = 0.15 * (successRate - 0.5)
  if (stats.latencyP50Ms !== undefined && stats.latencyP50Ms > SLOW_P50_MS) {
    adjustment -= 0.05
  }
  return adjustment
}
