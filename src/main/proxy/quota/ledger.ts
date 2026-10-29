/**
 * 额度账本：跨重启仍然有效的「这个账号在这个模型上已经用了多少」记录。
 *
 * 窗口口径是**滚动**的（分钟 / 24 小时）而月度按 **UTC 自然月**：
 * 滚动窗口相对上游的自然日只会更早判定用尽，宁可少发一个请求，
 * 也不把已经撞过墙的请求当成还有余量。
 *
 * 落盘沿用 requestLogs 的形态：目录 + 防抖批量写 + 临时文件 rename，
 * 读不到就按空账本起——账本丢了只劣化一次窗口内的选路，不碰任何凭据。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { TokenUsage } from './usage.ts'
import type { QuotaMetric } from './limits.ts'

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
/** 多留 5 分钟的桶，避免刚好卡在 24 小时边缘把日窗算少 */
const MINUTE_RETENTION_MS = DAY_MS + 5 * MINUTE_MS

export interface QuotaBucket {
  requests: number
  tokens: number
}

/** 分钟桶：键是 `YYYY-MM-DDTHH:MM`（UTC），内层键是 `QuotaLedger.key(...)` */
export type MinuteBuckets = Record<string, Record<string, QuotaBucket>>
/** 月度桶：键是 `YYYY-MM`（UTC） */
export type MonthBuckets = Record<string, Record<string, QuotaBucket>>

export interface LedgerSnapshot {
  providerId: string
  accountId: string
  modelId: string
  rpm: number
  rpd: number
  tpm: number
  tpd: number
  monthlyTokens: number
}

/** provider 级帽用的聚合名：同一账号下所有模型合到一起。 */
export const ALL_MODELS = '*'

export function minuteKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 16)
}

export function monthKey(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 7)
}

/** 空桶相加还是空桶，所以这里不需要区分「没用过」和「用了 0」。 */
function addBucket(target: Record<string, QuotaBucket>, key: string, requests: number, tokens: number): void {
  const current = target[key]
  if (current) {
    current.requests += requests
    current.tokens += tokens
    return
  }
  target[key] = { requests, tokens }
}

/** 分别求请求数与 token 数：一个窗口两件事，不能只回一个数。 */
function readWindow(
  minutes: MinuteBuckets,
  key: string,
  windowMs: number,
  nowMs: number
): { requests: number; tokens: number } {
  const from = nowMs - windowMs
  let requests = 0
  let tokens = 0

  for (const [stamp, buckets] of Object.entries(minutes)) {
    const at = Date.parse(`${stamp}:00Z`)
    if (Number.isNaN(at) || at < from || at > nowMs) continue
    const bucket = buckets[key]
    if (!bucket) continue
    requests += bucket.requests
    tokens += bucket.tokens
  }

  return { requests, tokens }
}

export class QuotaLedger {
  private readonly filePath: string
  private readonly now: () => number
  private minutes: MinuteBuckets = {}
  private months: MonthBuckets = {}
  /** 实测帽：按家存，只填空、只下调。官方帽存在与否由 shared/aggregateQuota 决定，这里只记观测值。 */
  private learned: Record<string, Partial<Record<QuotaMetric, number>>> = {}
  private initialized = false
  private dirty = false
  private persistTimer: NodeJS.Timeout | null = null
  private readonly persistDelayMs = 2000

  /** 时钟可注入：窗口与保留策略全靠时刻，不注入就只能按真实墙钟测。 */
  constructor(storageDir: string, now: () => number = () => Date.now()) {
    this.filePath = join(storageDir, 'quota-ledger.json')
    this.now = now
  }

  static key(providerId: string, accountId: string, modelId: string): string {
    return `${providerId}|${accountId}|${modelId}`
  }

  initialize(): void {
    if (this.initialized) return

    mkdirSync(dirname(this.filePath), { recursive: true })
    const loaded = this.load()
    if (loaded) {
      this.minutes = loaded.minutes
      this.months = loaded.months
      this.learned = loaded.learned
      this.prune(this.now())
    }
    this.initialized = true
  }

  /** 文件损坏时按空账本起，并把坏文件留下证——绝不静默覆盖真实数据。 */
  private load(): {
    minutes: MinuteBuckets
    months: MonthBuckets
    learned: Record<string, Partial<Record<QuotaMetric, number>>>
  } | null {
    if (!existsSync(this.filePath)) return null

    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as {
        version?: number
        minutes?: unknown
        months?: unknown
        learned?: unknown
      }
      if (parsed.version !== 1 || typeof parsed.minutes !== 'object' || typeof parsed.months !== 'object') {
        return null
      }
      return {
        minutes: parsed.minutes as MinuteBuckets,
        months: parsed.months as MonthBuckets,
        learned: (parsed.learned ?? {}) as Record<string, Partial<Record<QuotaMetric, number>>>,
      }
    } catch {
      const corrupt = join(
        dirname(this.filePath),
        `quota-ledger.corrupted.${Date.now()}.json`
      )
      try {
        renameSync(this.filePath, corrupt)
      } catch {
        /* 改名失败也只按空账本起，不阻断启动 */
      }
      return null
    }
  }

  record(providerId: string, accountId: string, modelId: string, usage: TokenUsage, atMs = this.now()): void {
    this.ensureInitialized()

    const requests = 1
    const tokens = Math.max(0, Math.floor(usage.totalTokens || 0))
    const stamp = minuteKey(atMs)
    const month = monthKey(atMs)

    this.minutes[stamp] ??= {}
    this.months[month] ??= {}

    addBucket(this.minutes[stamp], QuotaLedger.key(providerId, accountId, modelId), requests, tokens)
    addBucket(this.minutes[stamp], QuotaLedger.key(providerId, accountId, ALL_MODELS), requests, tokens)
    addBucket(this.months[month], QuotaLedger.key(providerId, accountId, modelId), requests, tokens)
    addBucket(this.months[month], QuotaLedger.key(providerId, accountId, ALL_MODELS), requests, tokens)

    this.dirty = true
    this.schedulePersist()
  }

  snapshot(providerId: string, accountId: string, modelId: string, nowMs = this.now()): LedgerSnapshot {
    this.ensureInitialized()

    const modelKey = QuotaLedger.key(providerId, accountId, modelId)
    const minute = readWindow(this.minutes, modelKey, MINUTE_MS, nowMs)
    const day = readWindow(this.minutes, modelKey, DAY_MS, nowMs)
    const month = this.months[monthKey(nowMs)]?.[modelKey]

    return {
      providerId,
      accountId,
      modelId,
      rpm: minute.requests,
      tpm: minute.tokens,
      rpd: day.requests,
      tpd: day.tokens,
      monthlyTokens: month?.tokens ?? 0,
    }
  }

  /** 同一账号在一家里所有模型的合计，provider 级帽用它。 */
  providerSnapshot(providerId: string, accountId: string, nowMs = this.now()): Omit<LedgerSnapshot, 'modelId'> {
    this.ensureInitialized()

    const key = QuotaLedger.key(providerId, accountId, ALL_MODELS)
    const minute = readWindow(this.minutes, key, MINUTE_MS, nowMs)
    const day = readWindow(this.minutes, key, DAY_MS, nowMs)
    const month = this.months[monthKey(nowMs)]?.[key]

    return {
      providerId,
      accountId,
      rpm: minute.requests,
      tpm: minute.tokens,
      rpd: day.requests,
      tpd: day.tokens,
      monthlyTokens: month?.tokens ?? 0,
    }
  }

  /** 只填空、只下调：已有更小的观测值时，更大的观测不得顶替。 */
  learn(providerId: string, metric: QuotaMetric, limit: number): boolean {
    this.ensureInitialized()
    if (!(limit > 0)) return false

    const current = this.learned[providerId]?.[metric]
    if (current !== undefined && current <= limit) return false

    this.learned[providerId] = { ...(this.learned[providerId] ?? {}), [metric]: limit }
    this.dirty = true
    this.schedulePersist()
    return true
  }

  learnedFor(providerId: string): Partial<Record<QuotaMetric, number>> {
    this.ensureInitialized()
    return { ...(this.learned[providerId] ?? {}) }
  }

  prune(nowMs: number): void {
    const from = nowMs - MINUTE_RETENTION_MS
    for (const stamp of Object.keys(this.minutes)) {
      const at = Date.parse(`${stamp}:00Z`)
      if (Number.isNaN(at) || at < from) delete this.minutes[stamp]
    }

    const currentMonth = monthKey(nowMs)
    const previousMonth = monthKey(nowMs - 32 * DAY_MS)
    for (const month of Object.keys(this.months)) {
      if (month !== currentMonth && month !== previousMonth) delete this.months[month]
    }
  }

  private ensureInitialized(): void {
    if (!this.initialized) this.initialize()
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.prune(this.now())
      this.persistNow()
    }, this.persistDelayMs)
    this.persistTimer.unref?.()
  }

  private persistNow(): void {
    if (!this.dirty) return

    const temp = `${this.filePath}.tmp`
    writeFileSync(
      temp,
      JSON.stringify({ version: 1, minutes: this.minutes, months: this.months, learned: this.learned }),
      'utf-8'
    )
    renameSync(temp, this.filePath)
    this.dirty = false
  }

  /** 退出前调用，避免丢掉最后 2 秒内的计数。 */
  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.initialized) return
    this.prune(this.now())
    this.persistNow()
  }
}
