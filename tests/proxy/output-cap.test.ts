/**
 * 输出上限两种拼法的归一（用户报障 2026-10-31：DSH 作客户端走 `auto` 每次都提示
 * 「已达到输出 token 上限」）。
 *
 * DSH 按 baseUrl 挑拼法，非白名单主机只发 `max_completion_tokens`；代理下游只读
 * `max_tokens`，于是上限被静默丢弃，上游按自己的默认值截断。这里钉住折叠本身，
 * 以及折叠后的值真的进了各条 wire 的请求体。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  ensureAnthropicOutputCap,
  normalizeOutputCap,
  outputCapFallbackOf,
} from '../../src/main/proxy/utils/outputCap.ts'
import { buildAnthropicRequest } from '../../src/main/proxy/adapters/anthropic.ts'
import { chatToResponsesRequest } from '../../src/shared/responsesWire.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'

// 客户端实际发来的形状：字段不在类型里也可能出现，按运行时形态造
const incoming = (body: Record<string, unknown>): ChatCompletionRequest =>
  ({ model: 'auto', messages: [{ role: 'user', content: 'hi' }], ...body }) as unknown as ChatCompletionRequest

test('只给 max_completion_tokens：折进 max_tokens，别名不再出现', () => {
  const folded = normalizeOutputCap(incoming({ max_completion_tokens: 32768 }))

  assert.equal(folded.max_tokens, 32768)
  assert.ok(!('max_completion_tokens' in folded), '别名必须撤掉，否则上游会同时收到两把')
})

test('两把都给：别名优先，与渠道包 worker、请求日志同口径', () => {
  const folded = normalizeOutputCap(incoming({ max_tokens: 1024, max_completion_tokens: 32768 }))

  assert.equal(folded.max_tokens, 32768)
  assert.ok(!('max_completion_tokens' in folded))
})

test('没给别名：原对象返回，不复制也不发明上限', () => {
  const withCap = incoming({ max_tokens: 2048 })
  assert.equal(normalizeOutputCap(withCap), withCap)

  const withoutCap = incoming({})
  const folded = normalizeOutputCap(withoutCap)
  assert.ok(!('max_tokens' in folded), '客户端没给上限就不补一个默认值')
})

test('入参不被修改', () => {
  const request = incoming({ max_completion_tokens: 32768 })
  const snapshot = JSON.parse(JSON.stringify(request))

  normalizeOutputCap(request)

  assert.deepEqual(JSON.parse(JSON.stringify(request)), snapshot)
})

test('折过的值真的进 anthropic 与 responses 请求体', () => {
  const folded = normalizeOutputCap(incoming({ max_completion_tokens: 32768 }))

  // 不折时这里是 4096（代码里的兜底），即截断的直接原因
  assert.equal(buildAnthropicRequest(folded, 'claude-sonnet').max_tokens, 32768)
  assert.equal(chatToResponsesRequest(folded).max_output_tokens, 32768)
})

test('默认分支读的正是折叠后的字段（openai-chat wire 覆盖 70 家聚合条目）', () => {
  // forwarder 拉进 electron，按源码钉：白名单若改读别的键，折叠就白做
  const forwarderSource = readFileSync('src/main/proxy/forwarder.ts', 'utf-8')

  assert.match(forwarderSource, /request\.max_tokens !== undefined/)
  assert.match(forwarderSource, /body\.max_tokens = request\.max_tokens/)
  assert.doesNotMatch(forwarderSource, /max_completion_tokens/, '转发体不该另读别名，单一口径由入口折叠保证')
})

test('anthropic wire 缺上限时补设置值，其余 wire 一律不补', () => {
  const bare = incoming({})

  assert.equal(ensureAnthropicOutputCap(bare, 'anthropic-messages', 16384).max_tokens, 16384)
  // 客户端（任一种写法）或每模型参数给了值就不覆盖
  assert.equal(ensureAnthropicOutputCap(incoming({ max_tokens: 32768 }), 'anthropic-messages', 16384).max_tokens, 32768)
  // 非 anthropic：不带上限=让上游自己定，代理不发明一个数
  assert.ok(!('max_tokens' in ensureAnthropicOutputCap(bare, 'openai-chat', 16384)))
  assert.ok(!('max_tokens' in ensureAnthropicOutputCap(bare, undefined, 16384)))
})

test('兜底只认正整数：手坏的设置回落常量，不写 0、不写小数、不写字符串', () => {
  assert.equal(outputCapFallbackOf(16384), 16384)
  assert.equal(outputCapFallbackOf(undefined), DEFAULT_MAX_OUTPUT_TOKENS)
  assert.equal(outputCapFallbackOf(0), DEFAULT_MAX_OUTPUT_TOKENS)
  assert.equal(outputCapFallbackOf(-5), DEFAULT_MAX_OUTPUT_TOKENS)
  assert.equal(outputCapFallbackOf(4096.5), DEFAULT_MAX_OUTPUT_TOKENS)
  assert.equal(outputCapFallbackOf('32768'), DEFAULT_MAX_OUTPUT_TOKENS)
})

test('报障形状全程走一遍：DSH 的上限不再被静默丢弃', () => {
  const dsh = incoming({ max_completion_tokens: 32768 })
  const sent = ensureAnthropicOutputCap(
    normalizeOutputCap(dsh),
    'anthropic-messages',
    outputCapFallbackOf(undefined)
  )

  // 不折叠时这里是 4096（兜底），即「已达到输出 token 上限」的直接来源
  assert.equal(buildAnthropicRequest(sent, 'claude-sonnet').max_tokens, 32768)
})
