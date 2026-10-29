/**
 * 转发重试预算的回归测试（纯函数，无 electron、无网络、无定时器）。
 *
 * 要钉住的是**两类 provider 的不对称**与**只下调**这一条方向：
 * 账号渠道的排队 / 额度 / 换号退避已经在渠道 Worker 里跑过一轮，宿主再按
 * 内建端点那套 `5s × retryCount` 叠加，就是用户体感的双重等待。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ACCOUNT_CHANNEL_MAX_RETRIES,
  ACCOUNT_CHANNEL_RETRY_DELAY_MS,
  DEFAULT_FORWARD_RETRY_DELAY_MS,
  planForwardRetries,
} from '../../src/main/proxy/retryPolicy.ts'

test('账号渠道只额外试一次，且用短退避', () => {
  const profile = planForwardRetries('account', 3)
  assert.deepEqual(profile, { maxRetries: ACCOUNT_CHANNEL_MAX_RETRIES, retryDelayMs: ACCOUNT_CHANNEL_RETRY_DELAY_MS })
})

test('其余 provider 保持历史预算（这次改动不许顺手改它们）', () => {
  for (const type of ['builtin', 'aggregate', 'custom'] as const) {
    const profile = planForwardRetries(type, 3)
    assert.deepEqual(profile, { maxRetries: 3, retryDelayMs: DEFAULT_FORWARD_RETRY_DELAY_MS })
  }
})

test('调用方显式给的预算只下调、绝不上调', () => {
  // `forwardAutoCompletion` / 链式转发传 `{ maxRetries: 0 }`：那是一句指令
  // （候选链上每个供应商只打一次，失败就换下一个），被上调成 1 会让整条链
  // 的等待翻倍，并且违背"失败立即换候选"的设计。
  assert.equal(planForwardRetries('account', 0).maxRetries, 0)
  assert.equal(planForwardRetries('builtin', 0).maxRetries, 0)
  // 账号渠道被封顶到 1，但用户配得更小时以用户为准。
  assert.equal(planForwardRetries('account', 1).maxRetries, 1)
  assert.equal(planForwardRetries('account', 5).maxRetries, ACCOUNT_CHANNEL_MAX_RETRIES)
})

test('两类的间隔必须保持不对称（"统一成一套"得先改掉这条）', () => {
  assert.ok(
    ACCOUNT_CHANNEL_RETRY_DELAY_MS < DEFAULT_FORWARD_RETRY_DELAY_MS,
    '账号渠道的宿主层退避必须短于内建端点：渠道内部已有自己的排队/超时退避',
  )
})

test('非法预算按 0 处理，而不是悄悄回落到默认 3 次', () => {
  // 回落成"看起来合理的默认值"是最坏的一种容错：`retryCount` 被写成 `NaN`
  // 时用户以为重试已关，实际每次失败仍在睡 5 秒。
  for (const bad of [Number.NaN, -1, undefined, null, 'x']) {
    assert.equal(planForwardRetries('builtin', bad as number).maxRetries, 0, `bad=${String(bad)}`)
    assert.equal(planForwardRetries('account', bad as number).maxRetries, 0)
  }
})

test('最坏情况的可加等待：账号渠道从 15 秒降到 0.5 秒', () => {
  // 这个数字本身就是这次改动的理由，写成断言是为了让"重新统一成一套"的
  // 编辑必须显式地改掉它，而不是顺手改完没人发现。
  const before = 3 * DEFAULT_FORWARD_RETRY_DELAY_MS
  const after = planForwardRetries('account', 3)
  assert.equal(before, 15_000)
  assert.equal(after.maxRetries * after.retryDelayMs, 500)
})
