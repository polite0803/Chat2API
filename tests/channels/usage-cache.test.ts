/**
 * 缓存口径判定的回归测试（`usage-cache.ts` 零依赖，可直接 import）。
 *
 * 要钉住的是**关系**而不是数值：把子集当并列会双计缓存（上下文虚高、客户端提前
 * 压缩），把并列当子集会双扣（上下文恒定偏小、自动压缩永不触发）—— 两个方向都是
 * `openai-gateway/usage.ts` 文件头那份 2026-10-04 用户报障的重现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readCachedInput, uncachedInput } from '../../vendor/channel-pack/src/usage-cache.ts'

test('OpenAI 系的 cached_tokens 是 prompt 的子集，要从 inputTokens 里减', () => {
  const u = { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } }
  const reading = readCachedInput(u)
  assert.deepEqual(reading, { cachedTokens: 800, subsetOfPrompt: true })
  assert.equal(uncachedInput(1000, reading), 200, 'DSH 的 inputTokens 不含缓存，网关会再加回去')
})

test('平铺的 prompt_cache_hit_tokens 同样是子集', () => {
  const reading = readCachedInput({ prompt_tokens: 500, prompt_cache_hit_tokens: 300 })
  assert.equal(reading.subsetOfPrompt, true)
  assert.equal(uncachedInput(500, reading), 200)
})

test('Anthropic 系的 cache_read_input_tokens 与 input 并列，绝不减', () => {
  const u = { input_tokens: 400, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 }
  const reading = readCachedInput(u)
  assert.deepEqual(reading, { cachedTokens: 900, subsetOfPrompt: false, cacheWriteTokens: 100 })
  assert.equal(uncachedInput(400, reading), 400, '并列口径下减它就错了')
})

test('OpenAI 与 Anthropic 字段同时出现时按子集算（details 优先）', () => {
  const u = { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 100 }, cache_read_input_tokens: 500 }
  const reading = readCachedInput(u)
  assert.equal(reading.subsetOfPrompt, true)
  assert.equal(reading.cachedTokens, 100)
})

test('没报就是 undefined，不是 0', () => {
  // `0` 是断言"这轮没命中"；缺省才是事实"上游没告诉我们"。写成 0 会让仪表盘
  // 宣称缓存没用上，而我们没有这个测量。
  assert.equal(readCachedInput({ prompt_tokens: 100 }).cachedTokens, undefined)
  assert.equal(readCachedInput({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } }).cachedTokens, undefined)
  assert.equal(readCachedInput({ prompt_tokens: 100, cache_read_input_tokens: 0 }).cachedTokens, undefined)
  assert.equal(uncachedInput(100, readCachedInput({ prompt_tokens: 100 })), 100, '没报缓存时输入原样保留')
})

test('上游报出 cached > prompt 时夹到 0，绝不返回负输入', () => {
  // 各家实现里都见过（通常是它把写入侧也算进了 cached）。负数会一路污染求和。
  const reading = readCachedInput({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 4000 } })
  assert.equal(uncachedInput(100, reading), 0)
})

test('畸形 usage 不抛错：null / 非对象 / 字符串 / NaN / 负数一律当没报', () => {
  // 用量字段"宁少不崩"：这里抛错会中断整轮对话，比少记一个数严重得多。
  for (const bad of [null, undefined, 'x', 7, [], { cached_tokens: 'abc' }, { prompt_tokens_details: null }]) {
    const r = readCachedInput(bad as Record<string, unknown>)
    assert.equal(r.cachedTokens, undefined, JSON.stringify(bad))
    assert.equal(r.subsetOfPrompt, false)
  }
  assert.equal(uncachedInput(Number.NaN, { cachedTokens: undefined, subsetOfPrompt: false }), 0)
  assert.equal(uncachedInput(-5, { cachedTokens: undefined, subsetOfPrompt: false }), 0)
})
