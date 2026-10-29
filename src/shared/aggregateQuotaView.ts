/**
 * 聚合页"这家有没有免费额度可用"的判定。
 *
 * 两件事分开说，不合并成一个徽章：
 * - `isFreePool`：静态事实，来自目录（`category: free-tier` / 免密 / 带 freeModelsHint）。
 * - `quotaState`：我们的证据状态（有没有数字、有没有打满、有没有 Key）。
 * 合成一个"可用/不可用"会让"官方没公布"看起来像"不能用"，而这两件事完全不同。
 *
 * 优先级：需要 Key（没有 Key 就没有计量） > 已打满 > 有官方数字 > 官方未公布 > 未录入。
 */

import type { AggregateEntry } from './aggregate'
import { AGGREGATE_QUOTA } from './aggregateQuota.ts'

/** 参与预检的五个额度维度（contextWindow 属于能力，不是额度）。定义在 shared，main 侧再导出。 */
export type QuotaMetric = 'rpm' | 'rpd' | 'tpm' | 'tpd' | 'monthlyTokens'

export type QuotaState = 'needs-key' | 'exhausted' | 'documented' | 'undocumented' | 'absent'

export interface QuotaUsage {
  rpm: number
  rpd: number
  tpm: number
  tpd: number
  monthlyTokens: number
}

export interface QuotaView {
  state: QuotaState
  /** 标称免费池：free-tier 类别、免密、或上游声明过免费模型 */
  isFreePool: boolean
  /** 触发"已打满"的那个窗口 */
  exhaustedMetric?: QuotaMetric
  used?: number
  limit?: number
  asOf?: string
  docUrl?: string
  /** 该家公布的上下文窗口；属于能力不是额度，单独给 */
  contextWindow?: number
  /**
   * 官方口径说明：单位不是 token 的上限（Neurons/日、请求/小时/IP、并发路数、美元/月等）
   * 与条件（充值门槛、账号合并计算）都在这里。**只显示，不参与预检**——
   * 折算成 token 等于替厂商发明换算率。
   */
  officialNote?: string
}

/** 这个窗口在本应用里是怎么算的：滚动分钟 / 滚动 24 小时 / UTC 自然月。 */
export type QuotaWindow = 'minute' | 'day' | 'month'

export const WINDOW_OF_METRIC: Record<QuotaMetric, QuotaWindow> = {
  rpm: 'minute',
  tpm: 'minute',
  rpd: 'day',
  tpd: 'day',
  monthlyTokens: 'month',
}

const METRICS = ['monthlyTokens', 'rpd', 'tpd', 'rpm', 'tpm'] as const

export function isFreePool(entry: Pick<AggregateEntry, 'category' | 'authKind' | 'freeModelsHint'>): boolean {
  return entry.category === 'free-tier' || entry.authKind === 'none' || (entry.freeModelsHint?.length ?? 0) > 0
}

export function quotaViewOf(
  entry: Pick<AggregateEntry, 'id' | 'category' | 'authKind' | 'freeModelsHint'>,
  options: { hasApiKey: boolean; usage?: QuotaUsage }
): QuotaView {
  const free = isFreePool(entry)
  const quota = AGGREGATE_QUOTA[entry.id]

  if (entry.authKind === 'apiKey' && !options.hasApiKey) {
    return { state: 'needs-key', isFreePool: free, asOf: quota?.asOf, docUrl: quota?.docUrl }
  }

  const usage = options.usage
  if (usage && quota) {
    for (const metric of METRICS) {
      const limit = quota[metric]
      if (typeof limit === 'number' && limit > 0 && usage[metric] >= limit) {
        return {
          state: 'exhausted',
          isFreePool: free,
          exhaustedMetric: metric,
          used: usage[metric],
          limit,
          asOf: quota.asOf,
          docUrl: quota.docUrl,
          contextWindow: quota.contextWindow,
          officialNote: quota.officialNote,
        }
      }
    }
  }

  if (quota?.source === 'documented') {
    return {
      state: 'documented',
      isFreePool: free,
      asOf: quota.asOf,
      docUrl: quota.docUrl,
      contextWindow: quota.contextWindow,
      officialNote: quota.officialNote,
    }
  }

  if (quota) {
    return {
      state: 'undocumented',
      isFreePool: free,
      asOf: quota.asOf,
      docUrl: quota.docUrl,
      officialNote: quota.officialNote,
    }
  }

  return { state: 'absent', isFreePool: free }
}

/** 面板上每个窗口的余量；没有官方数字的窗口不出现。窗口口径一并带出来，免得读成同一个"天"。 */
export function quotaRows(
  entryId: string,
  usage?: QuotaUsage
): Array<{ metric: QuotaMetric; limit: number; used: number; window: QuotaWindow }> {
  const quota = AGGREGATE_QUOTA[entryId]
  if (!quota) return []

  const rows: Array<{ metric: QuotaMetric; limit: number; used: number; window: QuotaWindow }> = []
  for (const metric of METRICS) {
    const limit = quota[metric]
    if (typeof limit === 'number' && limit > 0) {
      rows.push({ metric, limit, used: usage?.[metric] ?? 0, window: WINDOW_OF_METRIC[metric] })
    }
  }
  return rows
}
