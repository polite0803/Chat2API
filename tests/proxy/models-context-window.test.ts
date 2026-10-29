/**
 * `/v1/models` 下发窗口所用的查表规则（纯函数，无 store、无 electron）。
 *
 * 核心是**省略而不是兜底**：客户端拿 `context_window` 决定压缩时机，虚报上界会让
 * 它把超长上下文直接发出去、被服务端硬拒；写 0 会让它以为模型只有 0 窗口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { contextWindowOf } from '../../src/main/store/modelServing.ts'

// 能力表来自磁盘上的 JSON，所以"字段长歪"是真实输入而不是假想：这里刻意用
// `Record<string, unknown>` 装它，再在唯一一处调用点转型，避免把脏数据写进类型里。
const caps: Record<string, Record<string, unknown>> = {
  'Kimi-K3': { contextTokens: 128000 },
  'DeepSeek V4.1 Flash': { contextTokens: 200000 },
  'gpt-*': { contextTokens: 1_000_000 },
  'gpt-mini-*': { contextTokens: 262144 },
  'no-number': { vision: 'yes' },
  zero: { contextTokens: 0 },
  negative: { contextTokens: -1 },
  junk: { contextTokens: 'abc' },
}
const window = (name: string, table: Record<string, unknown> | undefined = caps): number | undefined =>
  contextWindowOf(table as never, name)

test('精确名命中就用它', () => {
  assert.equal(window('Kimi-K3'), 128000)
})

test('没标注就是没标注：返回 undefined，不是 0、也不是猜的默认值', () => {
  assert.equal(window('no-number'), undefined)
  assert.equal(window('never-heard-of-it'), undefined)
  assert.equal(window('Kimi-K3', {}), undefined)
  // ⚠️ 不能用 `window('Kimi-K3', undefined)`：那会命中上面那个参数的**默认值**又查回
  // 整张表（正是本用例要防的"回落默认"）。能力表真的缺失时走这条直连。
  assert.equal(contextWindowOf(undefined as never, 'Kimi-K3'), undefined)
})

test('0 / 负数 / 非数字 一律不发（省略键，绝不发个假的）', () => {
  for (const name of ['zero', 'negative', 'junk']) {
    assert.equal(window(name), undefined, name)
  }
})

test('通配目录名也能命中', () => {
  assert.equal(window('gpt-5.6-astra'), 1_000_000)
})

test('多个模式同时命中时取最小窗口：少报可用，多报会被上游拒', () => {
  // `gpt-mini-x` 同时匹配 `gpt-*`(1M) 与 `gpt-mini-*`(262144)。
  assert.equal(window('gpt-mini-x'), 262144)
})
