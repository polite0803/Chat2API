/**
 * PLAN-auto-routing-freellmapi P1-3/P1-4/P2-5 的回归测试。
 *
 * - P1-3 配额余量降权：账本（quota/ledger.ts）、429 学习（learnQuotaCaps）、
 *   前置剔除（quotaBlockReason）都是既有能力，本轮只补「余量进打分」这一环；
 * - P1-4 工具能力位：与 maxTools 同一循环，fail-open（缺省不限）；
 * - P2-5 Bandit 第一步：滚动 24h 成功率 + latency p50 加减分，冷启动乐观先验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  BANDIT_MIN_SAMPLES,
  aggregateBanditStats,
  banditAdjustment,
  banditKeyOf,
  latencyP50,
} from '../../src/main/proxy/autoBandit.ts'
import { rankCandidates, type RankCandidate } from '../../src/main/proxy/autoRouting.ts'

const NOW = 1_800_000_000_000

const autoRoutingSource = readFileSync('src/main/proxy/autoRouting.ts', 'utf-8')
const autoRouterSource = readFileSync('src/main/proxy/autoRouter.ts', 'utf-8')
const channelsSource = readFileSync('src/shared/channels.ts', 'utf-8')

/* ---------------- P2-5：Bandit 统计与加减分 ---------------- */

function entry(overrides: Partial<{
  timestamp: number
  status: 'success' | 'error'
  latency: number
  providerId: string
  actualModel: string
}>): {
  timestamp: number
  status: 'success' | 'error'
  latency: number
  providerId?: string
  actualModel?: string
} {
  return {
    timestamp: NOW - 1000,
    status: 'success',
    latency: 1000,
    providerId: 'loomy',
    actualModel: 'loomy/spark-x2.6',
    ...overrides,
  }
}

test('aggregateBanditStats：滚动 24h 窗口、键聚合、成功率', () => {
  const stats = aggregateBanditStats([
    entry({}),
    entry({}),
    entry({ status: 'error' }),
    // 窗口外：不计入
    entry({ timestamp: NOW - 25 * 60 * 60_000 }),
    // 无法归因：不计入
    entry({ providerId: undefined }),
    entry({ actualModel: undefined }),
  ], NOW)

  const key = banditKeyOf('loomy', 'loomy/spark-x2.6')
  assert.equal(stats.get(key)?.total, 3)
  assert.equal(stats.get(key)?.successes, 2)
})

test('aggregateBanditStats：latency p50（奇偶样本）', () => {
  assert.equal(latencyP50([]), undefined)
  assert.equal(latencyP50([300, 100, 200]), 200)
  assert.equal(latencyP50([400, 100, 300, 200]), 250)
})

test('banditAdjustment：冷启动乐观先验 —— 无样本/样本不足不调整', () => {
  assert.equal(banditAdjustment(undefined), 0)
  assert.equal(banditAdjustment({ total: BANDIT_MIN_SAMPLES - 1, successes: 0 }), 0)
})

test('banditAdjustment：成功率说话，显著慢再轻罚', () => {
  // 全成 → +0.075；全败 → -0.075
  assert.ok(banditAdjustment({ total: 10, successes: 10 }) > 0.07)
  assert.ok(banditAdjustment({ total: 10, successes: 0 }) < -0.07)
  // 半成半败 → 0
  assert.equal(banditAdjustment({ total: 10, successes: 5 }), 0)
  // 显著慢（p50 > 30s）再扣 0.05
  const fast = banditAdjustment({ total: 10, successes: 0 })
  const slow = banditAdjustment({ total: 10, successes: 0, latencyP50Ms: 31_000 })
  assert.equal(slow - fast, -0.05)
})

test('rankCandidates：Bandit 战绩要能改写同分候选的排序', () => {
  const base = {
    providerId: 'p',
    providerName: 'P',
    displayName: 'm',
    actualModelId: 'm',
    contractCapable: true,
    costBucket: 'unknown' as const,
  }
  const good: RankCandidate = {
    ...base,
    accountId: 'a1',
    live: { total: 10, successes: 10 },
  }
  const bad: RankCandidate = {
    ...base,
    accountId: 'a2',
    live: { total: 10, successes: 0 },
  }

  const ranked = rankCandidates(
    { complexity: 'standard', needsTools: false, needsVision: false, estimatedTokens: 0 },
    [bad, good],
    { now: NOW, limit: 2, seed: 0, strategy: 'round-robin', prefer: 'balanced' }
  )
  assert.equal(ranked[0]?.accountId, 'a1', '高成功率候选应排前')
})

/* ---------------- P1-3：配额余量降权 ---------------- */

test('rankCandidates：余量 <10% 的候选要被降权（耗尽的早被前置剔除）', () => {
  const base = {
    providerId: 'p',
    providerName: 'P',
    displayName: 'm',
    actualModelId: 'm',
    contractCapable: true,
    costBucket: 'unknown' as const,
  }
  const fresh: RankCandidate = { ...base, accountId: 'a1', quotaHeadroom: 1 }
  const nearly: RankCandidate = { ...base, accountId: 'a2', quotaHeadroom: 0.05 }

  const ranked = rankCandidates(
    { complexity: 'standard', needsTools: false, needsVision: false, estimatedTokens: 0 },
    [nearly, fresh],
    { now: NOW, limit: 2, seed: 0, strategy: 'round-robin', prefer: 'balanced' }
  )
  assert.equal(ranked[0]?.accountId, 'a1', '余量充足的候选应排前')

  // 无帽（0.5 中性）不扣分：与余量充足者同分时按稳定序并列，不因 headroom 落后。
  // 用 fill-first 而不是 round-robin：后者的按账号抖动（dispersion，≤0.00086）
  // 会让严格同分的两个候选顺序随 accountId 的哈希翻转，这里的断言考的是
  // quotaPenalty 语义，不该被轮转噪声劫持。
  const uncaped: RankCandidate = { ...base, accountId: 'a3', quotaHeadroom: 0.5 }
  const ranked2 = rankCandidates(
    { complexity: 'standard', needsTools: false, needsVision: false, estimatedTokens: 0 },
    [uncaped, fresh],
    { now: NOW, limit: 2, seed: 0, strategy: 'fill-first', prefer: 'balanced' }
  )
  assert.equal(ranked2[0]?.accountId, fresh.accountId, '中性 0.5 不得比余量 1.0 排前')
})

test('autoRouter 必须把账本余量与 Bandit 战绩喂进打分（源码钉点）', () => {
  // Bandit 表每请求聚合一次
  assert.match(
    autoRouterSource,
    /aggregateBanditStats\(storeManager\.getRequestLogs\(\), now\)/,
    'select must aggregate the 24h bandit table from the request-log memory copy',
  )
  // 余量只对聚合目录候选计算（账号渠道的帽在渠道 worker 内部）
  assert.match(
    autoRouterSource,
    /provider\.type === 'aggregate'\r?\n\s*\? aggregateHeadroom\(provider\.id, model\.actualModelId\)/,
    'quota headroom must come from the existing gate, only for aggregate candidates',
  )
  // 打分函数的两个新因子要进总分（钉 balanced 主路径与 fill-first）
  assert.match(autoRoutingSource, /- penalty - quotaPenalty \+ costBonus \+ stickyBonus \+ liveBonus/)
  assert.match(autoRoutingSource, /0\.1 \* \(1 - candidate\.quotaHeadroom \/ 0\.1\)/)
})

/* ---------------- P1-4：工具能力位（与 maxTools 同一循环） ---------------- */

test('ChannelDefinition 必须有 capabilities.tools 能力位（fail-open 语义）', () => {
  assert.match(
    channelsSource,
    /capabilities\?: \{\r?\n\s*tools\?: boolean\r?\n\s*\}/,
    'ChannelDefinition must carry the tools capability flag',
  )
})

test('autoRouter 的能力位过滤必须与 maxTools 同一循环且 fail-open（源码钉点）', () => {
  assert.match(
    autoRouterSource,
    /channelDefinition\?\.capabilities\?\.tools === false && toolCount > 0/,
    'only tool-carrying requests are blocked by tools:false; others route normally',
  )
  assert.match(
    autoRouterSource,
    /skipped\.add\(`\$\{provider\.id\}:tools_unsupported`\)/,
    'capability-excluded channels must be recorded as skipped',
  )
})
