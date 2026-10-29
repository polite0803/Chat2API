/**
 * 渠道上下文窗口的合并与能力标注（纯函数，无 electron、无 worker）。
 *
 * 要钉住的行为：窗口**只在渠道包明确说了时**才进能力表。写死一个小值不是"保守"，
 * 而是让 `auto` 路由把整条渠道在长上下文请求上硬过滤掉 —— 这是本次改动的真实动机，
 * 所以"缺失保持未知"和"命中要写对"同样重要。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readModelList,
  attachContextWindows,
  capabilityHintOf,
} from '../../src/main/providers/accountChannels/modelCatalog.ts'

const info = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  free: false,
  disabled: false,
  dead: false,
  ...extra,
})

test('视图里的 context_window 能按裸 id 合并进目录', () => {
  const models = [info('deepseek-v4.1-flash', { weight: undefined })]
  const view = [{ id: 'trae/deepseek-v4.1-flash', context_window: 1_000_000 }]
  const merged = attachContextWindows(models, view)
  assert.equal(merged[0].contextWindow, 1_000_000)
})

test('目录条目本身带前缀时也命中', () => {
  const merged = attachContextWindows([info('loomy/qwen3.8-flash')], [{ id: 'loomy/qwen3.8-flash', context_window: 262_144 }])
  assert.equal(merged[0].contextWindow, 262_144)
})

test('视图没有这个模型时保持未知，绝不回落默认值', () => {
  const models = [info('summary')]
  const merged = attachContextWindows(models, [{ id: 'trae/other', context_window: 100 }])
  assert.equal('contextWindow' in merged[0], false, '缺字段 = 渠道包没说；写个数会让 auto 误判')
  assert.deepEqual(merged[0], models[0], '未命中的条目内容必须原样')
})

test('非法的 context_window 一律忽略', () => {
  for (const bad of [0, -1, 'abc', Number.NaN, null]) {
    const merged = attachContextWindows([info('m')], [{ id: 'trae/m', context_window: bad }])
    assert.equal('contextWindow' in merged[0], false, `bad=${String(bad)}`)
  }
})

test('合并不修改传入数组或其元素（仓库的不可变规矩）', () => {
  const models = [info('m')]
  const before = { ...models[0] }
  const merged = attachContextWindows(models, [{ id: 'c/m', context_window: 500 }])
  assert.notEqual(merged, models)
  assert.notEqual(merged[0], models[0])
  assert.deepEqual(models[0], before, '入参必须保持原状')
  assert.equal(models[0].contextWindow, undefined)
})

test('model.list 万一哪天带上了窗口字段，也认两种拼写', () => {
  const snake = readModelList({ models: [{ id: 'a', name: 'A', context_window: 131_072 }] })
  const camel = readModelList({ models: [{ id: 'b', name: 'B', contextWindow: 131_072 }] })
  assert.equal(snake[0].contextWindow, 131_072)
  assert.equal(camel[0].contextWindow, 131_072)
  assert.equal(readModelList({ models: [{ id: 'c', name: 'C', context_window: 0 }] })[0].contextWindow, undefined)
})

test('能力表：有窗口才写 contextTokens，且它单独也足以成为一条能力', () => {
  assert.equal(capabilityHintOf(info('x') as never)?.contextTokens, undefined)
  const hint = capabilityHintOf(info('x', { contextWindow: 503_128 }) as never)
  assert.equal(hint?.contextTokens, 503_128, 'auto 路由拿它做硬过滤，丢了就等于把渠道判死')
  // 只带窗口、没有倍率/模态时也必须返回一条能力（过去会返回 undefined 而整条丢掉）
  assert.notEqual(hint, undefined)
  assert.equal('free' in (hint ?? {}), false, '没有倍率信息时不得声称免费')
})
