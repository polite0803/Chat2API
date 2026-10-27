/**
 * Auto 模型路由器
 *
 * 把 `auto` 这个虚拟模型解析成一串真实候选 (账号, 供应商, 模型)，
 * 决策逻辑在 autoRouting.ts 中，本文件只负责数据采集与冷却状态。
 */

import { storeManager } from '../store/store'
import type { Account, Provider } from '../store/types'
import type { ChatCompletionRequest } from './types'
import { accountRuntime } from './accountRuntime'
import {
  conversationKey,
  profileRequest,
  rankCandidates,
  type AutoRoutingStrategy,
  type RankCandidate,
  type RequestProfile,
} from './autoRouting'

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
}

interface StickyRoute {
  candidateKey: string
  expiresAt: number
}

function isAutoModel(model: unknown): boolean {
  return typeof model === 'string' && model.trim().toLowerCase() === AUTO_MODEL_ID
}

function candidateKey(providerId: string, accountId: string, displayName: string): string {
  return `${providerId}:${accountId}:${displayName}`
}

class AutoRouter {
  private seed = 0
  /** 会话指纹 -> 上次成功的候选，用于多轮粘性 */
  private sticky = new Map<string, StickyRoute>()

  /**
   * 为本次请求选出有序候选列表；空数组表示没有可用目标
   */
  select(request: ChatCompletionRequest, strategy: AutoRoutingStrategy = 'round-robin'): AutoRouteDecision {
    const profile = profileRequest(request)
    const providers = storeManager.getProviders().filter(provider => provider.enabled)
    const now = Date.now()

    const autoConfig = storeManager.getConfig().autoRouting
    const maxAttempts = autoConfig?.maxAttempts ?? AUTO_MAX_ATTEMPTS
    const stickyMinutes = autoConfig?.stickyMinutes ?? 0

    const rankInputs: RankCandidate[] = []
    const candidatesByKey = new Map<string, AutoCandidate>()

    for (const provider of providers) {
      const accounts = storeManager
        .getAccountsByProviderId(provider.id, true)
        .filter(account => account.status === 'active')

      if (accounts.length === 0) {
        continue
      }

      for (const model of storeManager.getEffectiveModels(provider.id)) {
        // 通配符模型名不能作为上游真实模型使用
        if (model.displayName.endsWith('*')) {
          continue
        }

        for (const account of accounts) {
          if (account.dailyLimit && (account.todayUsed ?? 0) >= account.dailyLimit) {
            continue
          }

          const runtime = accountRuntime.snapshot(account.id, now)
          const key = candidateKey(provider.id, account.id, model.displayName)
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

    const seed = this.seed++
    // 先不截断，否则被钉住的候选若排在 maxAttempts 之后会查不到
    const ranked = rankCandidates(profile, rankInputs, {
      now,
      limit: Math.max(maxAttempts, rankInputs.length),
      seed,
      strategy,
    })

    const candidates: AutoCandidate[] = []
    for (const input of ranked) {
      const candidate = candidatesByKey.get(
        candidateKey(input.providerId, input.accountId, input.displayName)
      )
      if (candidate) {
        candidates.push(candidate)
      }
    }

    const key = conversationKey(request)
    if (key && stickyMinutes > 0) {
      const route = this.sticky.get(key)
      if (route && route.expiresAt > now) {
        const index = candidates.findIndex(candidate =>
          candidateKey(candidate.provider.id, candidate.account.id, candidate.displayName) === route.candidateKey
        )
        if (index > 0) {
          const [pinned] = candidates.splice(index, 1)
          candidates.unshift(pinned)
        }
      } else if (route) {
        this.sticky.delete(key)
      }
    }

    return { profile, candidates: candidates.slice(0, maxAttempts), conversationKey: key }
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
      candidateKey: candidateKey(candidate.provider.id, candidate.account.id, candidate.displayName),
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
