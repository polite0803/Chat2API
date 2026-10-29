/**
 * Auto 模型路由器
 *
 * 把 `auto` 这个虚拟模型解析成一串真实候选 (账号, 供应商, 模型)，
 * 决策逻辑在 autoRouting.ts 中，本文件只负责数据采集与冷却状态。
 */

import { storeManager } from '../store/store'
import type { Account, Provider } from '../store/types'
import type { AutoPreference, ModelCapabilityHint } from '../../shared/types'
import type { ChatCompletionRequest } from './types'
import { accountRuntime } from './accountRuntime'
import {
  applyContractFilter,
  contractNeeds,
  explainMissing,
  conversationKey,
  profileRequest,
  providerMeetsContract,
  rankCandidates,
  type AutoRoutingStrategy,
  type RankCandidate,
  type RequestProfile,
  type StickyHint,
} from './autoRouting'
import { quotaBlockReason } from './quota/gate.ts'
import { aggregateContextWindow } from './modelCapabilities.ts'
import { costBucketOf, type CostBucket } from '../../shared/channels.ts'
import { aggregateCostOf, costBucketOfAggregateClass } from '../../shared/aggregateCost.ts'
import { getAggregateEntry } from '../providers/aggregate/registry.ts'

/** 对外暴露的虚拟模型 id，保留字：不能作为真实模型或映射名 */
export const AUTO_MODEL_ID = 'auto'

/** 配置缺失时最多失败切换几次 */
const AUTO_MAX_ATTEMPTS = 3

/** 会话粘性表容量上限，超出后按插入顺序淘汰最旧的条目 */
const STICKY_CAPACITY = 500

export interface AutoCandidate {
  account: Account
  provider: Provider
  displayName: string
  actualModel: string
}

export interface AutoRouteDecision {
  profile: RequestProfile
  candidates: AutoCandidate[]
  /** 会话指纹，成功后可交给 rememberRoute 固化本次选择 */
  conversationKey?: string
  /**
   * 本次为了路由成功而放宽的契约（`response_format`）。空数组表示候选
   * 完整满足；非空时路由层必须在响应头里写明，不能假装满足。
   */
  degraded: string[]
  /** 空候选时说明缺的到底是什么，供 503/400 的 details 使用 */
  missing: string[]
  /** 本次生效的优化目标（配置值或请求头覆盖） */
  prefer: AutoPreference
  /** 胜负原因：只有一个候选 / 命中会话粘性 / 综合分 */
  reason: 'only' | 'sticky' | 'score'
}

interface StickyRoute {
  hint: StickyHint
  expiresAt: number
}

/**
 * 一个模型的成本档：渠道目录报的倍率最权威，其次是聚合条目的免费标记；
 * 内置与自定义没有任何成本信息，返回 unknown（打分里取中性值）。
 *
 * 聚合条目走 `shared/aggregateCost.ts` 的分类，而不是直接看 `freeModelsHint`：
 * 那条老路径只认"免费池类别或免费清单"，于是 91 条有第三方标价的模型
 * （以及所有订阅端点）全部落进 unknown，`cheap` 偏好实际上挑不到免费模型。
 * 分类器把"官方免费 / 目录免费 / 套餐内 / 按量 / 未知"分开，这里只做档位映射：
 * 套餐内与免费同档（请求时刻的现金支出都是 0），按量一律 above-base
 * （USD 没有倍率基准，只能回答"要不要额外花钱"）。
 */
function costBucketFor(
  provider: Provider,
  actualModelId: string,
  hint: ModelCapabilityHint | undefined
): CostBucket {
  const free = hint?.free === true
  if (free) return 'free'
  if (hint?.weight !== undefined) return costBucketOf(hint.weight, free)

  if (provider.type === 'aggregate') {
    const entry = getAggregateEntry(provider.aggregateId ?? provider.id)
    if (entry !== undefined) {
      const signal = aggregateCostOf({
        entryId: entry.id,
        modelId: actualModelId,
        ...(entry.freeModelsHint ? { freeModelsHint: entry.freeModelsHint } : {}),
      })
      return costBucketOfAggregateClass(signal.class)
    }
  }

  return 'unknown'
}

function isAutoModel(model: unknown): boolean {
  return typeof model === 'string' && model.trim().toLowerCase() === AUTO_MODEL_ID
}

function candidateKey(providerId: string, accountId: string, displayName: string): string {
  return `${providerId}:${accountId}:${displayName}`
}

/**
 * 一个模型的标注来源：供应商记录里的（账号渠道同步、内置同步写入）优先，
 * 聚合再用额度旁表里的上下文窗口补齐。都没有就是未知，不填默认值。
 */
function capabilityHintFor(provider: Provider, displayName: string, actualModelId: string): ModelCapabilityHint | undefined {
  const stored = provider.modelCapabilities?.[displayName]
  const aggregate = provider.type === 'aggregate'
    ? aggregateContextWindow(provider.aggregateId ?? provider.id, actualModelId)
    : undefined

  if (stored === undefined && aggregate === undefined) return undefined
  return {
    ...(aggregate === undefined ? {} : { contextTokens: aggregate }),
    ...stored,
  }
}


class AutoRouter {
  private seed = 0
  /** 会话指纹 -> 上次成功的候选，用于多轮粘性 */
  private sticky = new Map<string, StickyRoute>()

  /**
   * 为本次请求选出有序候选列表；空数组表示没有可用目标
   */
  select(
    request: ChatCompletionRequest,
    strategy: AutoRoutingStrategy = 'round-robin',
    preferOverride?: AutoPreference
  ): AutoRouteDecision {
    const profile = profileRequest(request)
    const providers = storeManager.getProviders().filter(provider => provider.enabled)
    const now = Date.now()

    const autoConfig = storeManager.getConfig().autoRouting
    const maxAttempts = autoConfig?.maxAttempts ?? AUTO_MAX_ATTEMPTS
    const stickyMinutes = autoConfig?.stickyMinutes ?? 0
    const prefer = preferOverride ?? autoConfig?.prefer ?? 'balanced'

    const rankInputs: RankCandidate[] = []
    const candidatesByKey = new Map<string, AutoCandidate>()
    const needs = contractNeeds(request)

    for (const provider of providers) {
      const accounts = storeManager
        .getAccountsByProviderId(provider.id, true)
        .filter(account => account.status === 'active')

      if (accounts.length === 0) {
        continue
      }

      const contractCapable = providerMeetsContract(provider.type, needs)

      for (const model of storeManager.getEffectiveModels(provider.id)) {
        // 通配符模型名不能作为上游真实模型使用
        if (model.displayName.endsWith('*')) {
          continue
        }

        for (const account of accounts) {
          if (account.dailyLimit && (account.todayUsed ?? 0) >= account.dailyLimit) {
            continue
          }

          // 额度已打满的候选根本不进排序，失败切换才不会浪费一次上游请求
          if (quotaBlockReason(provider, account.id, model.actualModelId)) {
            continue
          }

          const runtime = accountRuntime.snapshot(account.id, now)
          const key = candidateKey(provider.id, account.id, model.displayName)
          const capabilityHint = capabilityHintFor(provider, model.displayName, model.actualModelId)
          rankInputs.push({
            providerId: provider.id,
            providerName: provider.name,
            displayName: model.displayName,
            actualModelId: model.actualModelId,
            accountId: account.id,
            todayUsed: account.todayUsed,
            dailyLimit: account.dailyLimit,
            lastUsed: account.lastUsed,
            inFlight: runtime.inFlight,
            rpmUsed: runtime.rpmUsed,
            coolingUntil: runtime.coolingUntil,
            capabilityHint,
            contractCapable,
            costBucket: costBucketFor(provider, model.actualModelId, capabilityHint),
          })
          candidatesByKey.set(key, {
            account,
            provider,
            displayName: model.displayName,
            actualModel: model.actualModelId,
          })
        }
      }
    }

    // 契约过滤：有能满足的候选就只在它们里面挑；全都不满足时
    // `n > 1` 直接交给调用方报 400（内置供应商本来就这样拒绝），
    // `response_format` 则照常路由并标记降级——返回自由文本比拒绝可用。
    const contract = applyContractFilter(rankInputs, needs)
    const pool = contract.pool
    const degraded = contract.degraded
    const missing = contract.missing

    const seed = this.seed++
    const key = conversationKey(request)
    let sticky: StickyHint | undefined
    if (key && stickyMinutes > 0) {
      const route = this.sticky.get(key)
      if (route && route.expiresAt > now) {
        sticky = route.hint
      } else if (route) {
        this.sticky.delete(key)
      }
    }

    const ranked = rankCandidates(profile, pool, {
      now,
      limit: Math.max(maxAttempts, pool.length),
      seed,
      strategy,
      prefer,
      sticky,
    })

    // 候选池非空却排不出结果时，说明缺的是某种能力，而不是没有供应商
    if (ranked.length === 0 && missing.length === 0) {
      missing.push(...explainMissing(profile, pool))
    }

    const candidates: AutoCandidate[] = []
    for (const input of ranked) {
      const candidate = candidatesByKey.get(
        candidateKey(input.providerId, input.accountId, input.displayName)
      )
      if (candidate) {
        candidates.push(candidate)
      }
    }

    // 会话粘性已经在打分里加了分，这里不再重排：首选不可用时它自然让位。
    // 命中粘性的原因仍然要如实报出去，供响应头/日志使用。
    const stickyHit = sticky !== undefined
      && candidates[0] !== undefined
      && candidates[0].provider.id === sticky.providerId
      && candidates[0].displayName === sticky.displayName

    return {
      profile,
      candidates: candidates.slice(0, maxAttempts),
      conversationKey: key,
      degraded,
      missing,
      prefer,
      reason: candidates.length <= 1 ? 'only' : stickyHit ? 'sticky' : 'score',
    }
  }

  /**
   * 记录本次成功的路由，让同一会话在 stickyMinutes 内优先命中同一个模型。
   * 被钉住的候选若因冷却/配额从候选池消失，会自然失效，不需要额外清理。
   */
  rememberRoute(key: string | undefined, candidate: AutoCandidate): void {
    if (!key) return

    const minutes = storeManager.getConfig().autoRouting?.stickyMinutes ?? 0
    if (minutes <= 0) return

    const now = Date.now()
    for (const [stickyKey, route] of this.sticky) {
      if (route.expiresAt <= now) {
        this.sticky.delete(stickyKey)
      }
    }

    this.sticky.delete(key)
    this.sticky.set(key, {
      hint: {
        providerId: candidate.provider.id,
        displayName: candidate.displayName,
        accountId: candidate.account.id,
      },
      expiresAt: now + minutes * 60 * 1000,
    })

    while (this.sticky.size > STICKY_CAPACITY) {
      const oldest = this.sticky.keys().next()
      if (oldest.done) break
      this.sticky.delete(oldest.value)
    }
  }

  /** 该账号当前是否处于冷却期 */
  isAccountCooling(accountId: string): boolean {
    return accountRuntime.isCooling(accountId)
  }

  /** 标记账号冷却：429 按分钟级指数退避，其余错误按秒级退避 */
  markAccountCooldown(accountId: string, status?: number): void {
    accountRuntime.recordFailure(accountId, status)
  }

  clearAccountCooldown(accountId: string): void {
    accountRuntime.recordSuccess(accountId)
  }

  /** 代理服务重启时清空，避免跨进程生命周期残留 */
  reset(): void {
    accountRuntime.reset()
    this.sticky.clear()
    this.seed = 0
  }
}

export const autoRouter = new AutoRouter()
export { isAutoModel }
export default autoRouter
