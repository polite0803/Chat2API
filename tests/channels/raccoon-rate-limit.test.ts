/**
 * Raccoon 频率超限判据（`raccoon-rate-limit.ts`）的回归测试。
 *
 * 背景（2026-10-31 用户报障）：raccoon 网关把限流包在 **HTTP 5xx** 里下发
 * （正文「您的模型请求频率超限，请稍后重试」），适配器原按 5xx 归 SERVER，
 * 客户端看到 502 硬重试（4 分钟 15 连撞），且不换号不标记。
 *
 * 契约核心：
 * 1. 实测报障原文必须命中（正文判据）；
 * 2. HTTP 429 无条件命中；
 * 3. 判据窄：无关 5xx（真故障）与含泛化词的错误**不得**命中，避免账号被
 *    错误挂上冷却。
 *
 * ⚠️ 被测模块**零 import**，可直接以 TS 源动态加载（同 queue-wait.test.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VENDOR_SRC = join(ROOT, 'vendor', 'channel-pack', 'src')

async function loadModule() {
  return await import(pathToFileURL(join(VENDOR_SRC, 'raccoon-rate-limit.ts')).href)
}

test('实测报障原文（5xx + 频率超限文案）必须命中', async () => {
  const { isRaccoonRateLimitError } = await loadModule()
  const body = '{"error":{"message":"您的模型请求频率超限，请稍后重试","type":"api_error","param":null,"code":null}}'
  assert.equal(isRaccoonRateLimitError(502, body), true, '5xx 包裹的频率超限必须命中')
  assert.equal(isRaccoonRateLimitError(500, '您的模型请求频率超限，请稍后重试'), true)
  assert.equal(isRaccoonRateLimitError(503, '请求过于频繁，请稍后再试'), true)
})

test('HTTP 429 无条件命中（空正文也算）', async () => {
  const { isRaccoonRateLimitError } = await loadModule()
  assert.equal(isRaccoonRateLimitError(429, ''), true)
  assert.equal(isRaccoonRateLimitError(429, 'anything'), true)
})

test('英文限流文案命中', async () => {
  const { isRaccoonRateLimitError } = await loadModule()
  assert.equal(isRaccoonRateLimitError(502, 'rate limit exceeded, retry later'), true)
  assert.equal(isRaccoonRateLimitError(500, 'Too Many Requests'), true)
})

test('无关错误不得命中（防误挂冷却）', async () => {
  const { isRaccoonRateLimitError } = await loadModule()
  // 真正的服务端故障
  assert.equal(isRaccoonRateLimitError(502, 'upstream connect error'), false)
  assert.equal(isRaccoonRateLimitError(500, 'internal server error'), false)
  // 含「重试」但无限流语义的错误
  assert.equal(isRaccoonRateLimitError(502, '请求失败，请重试'), false)
  // 含「重置」的无关错误（共享宽 pattern 的过泛词，这里刻意不采用）
  assert.equal(isRaccoonRateLimitError(502, '密码已重置'), false)
  // 积分不足归额度耗尽判据，不算频率超限
  assert.equal(isRaccoonRateLimitError(402, '积分不足'), false)
  assert.equal(isRaccoonRateLimitError(200, ''), false)
})

test('冷却参数：分钟级短冷却，非当日 24:00 长标记', async () => {
  const { RACCOON_RATE_LIMIT_COOLDOWN_MS } = await loadModule()
  assert.ok(RACCOON_RATE_LIMIT_COOLDOWN_MS > 0 && RACCOON_RATE_LIMIT_COOLDOWN_MS <= 5 * 60_000,
    `频率超限冷却必须为分钟级，实际 ${RACCOON_RATE_LIMIT_COOLDOWN_MS}ms`)
})
