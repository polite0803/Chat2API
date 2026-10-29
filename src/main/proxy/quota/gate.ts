/**
 * 额度闸门：给选号阶段用的一句判断。
 *
 * 三处调用方（auto 候选枚举、命名模型的账号过滤、裸名跨家链）共用这一份，
 * 免得同一个判据各写一遍之后开始漂移。
 *
 * 两条不可让步的规则：
 * - 只对聚合目录的家生效：别的类型没有额度旁表，判了也是凭空拒绝。
 * - 账本读不出来时放行并记日志：保护层的缺席不能变成"这家不能服务"。
 */

import { storeManager } from '../../store/store'
import { evaluateQuota, resolveCaps, type QuotaBlockReason } from './limits.ts'

export function quotaBlockReason(
  provider: { id: string; type: string },
  accountId: string,
  actualModel: string
): QuotaBlockReason | undefined {
  if (provider.type !== 'aggregate') return undefined

  try {
    const ledger = storeManager.getQuotaLedger()
    const caps = resolveCaps(provider.id, actualModel, ledger.learnedFor(provider.id))
    const decision = evaluateQuota(caps, ledger.snapshot(provider.id, accountId, actualModel))
    return decision.allowed ? undefined : decision.reason
  } catch (error) {
    console.error('[QuotaGate] quota preflight skipped:', error)
    return undefined
  }
}

/** 1 = 完全空；0 = 刚好打满；-1 = 已超（排最后）。没有官方数字的家给 0.5 的中性分。 */
export function aggregateHeadroom(entryId: string, modelId: string): number {
  try {
    const ledger = storeManager.getQuotaLedger()
    const caps = resolveCaps(entryId, modelId, ledger.learnedFor(entryId))
    if (!caps.enforceable) return 0.5

    let worst = 0
    for (const account of storeManager.getAccountsByProviderId(entryId)) {
      const usage = ledger.snapshot(entryId, account.id, modelId)
      for (const [metric, limit] of Object.entries(caps.limits) as Array<[keyof typeof usage, number]>) {
        if (limit > 0 && typeof usage[metric] === 'number') {
          worst = Math.max(worst, usage[metric] / limit)
        }
      }
    }
    return worst >= 1 ? -1 : 1 - worst
  } catch (error) {
    console.error('[QuotaGate] aggregate headroom unavailable:', error)
    return 0.5
  }
}
