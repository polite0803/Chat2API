import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  readModelList,
  splitModelLabel,
} from '../../src/main/providers/accountChannels/modelCatalog.ts'

test('the multiplier is split out of the display name', () => {
  assert.deepEqual(splitModelLabel('MiniMax M3 · x4.0'), { name: 'MiniMax M3', free: false, weight: 4 })
  assert.deepEqual(splitModelLabel('Kimi-K3 · x1'), { name: 'Kimi-K3', free: false, weight: 1 })
  assert.deepEqual(splitModelLabel('Spark X2.5 · x0.1'), { name: 'Spark X2.5', free: false, weight: 0.1 })
})

test('a promo window keeps the original rate next to the effective one', () => {
  assert.deepEqual(splitModelLabel('GLM-5-3-Flash · x0.2→x0.1'), {
    name: 'GLM-5-3-Flash',
    free: false,
    weight: 0.1,
    baseWeight: 0.2,
  })
})

test('免费 means weight 0, and a zero rate is free too', () => {
  assert.deepEqual(splitModelLabel('Qwen3.8-Flash · 免费'), { name: 'Qwen3.8-Flash', free: true, weight: 0 })
  assert.deepEqual(splitModelLabel('Zero · x0'), { name: 'Zero', free: true, weight: 0 })
})

test('a label without a rate keeps an unknown weight, never 0', () => {
  // trae/minimax 这类渠道根本不报倍率：把「未知」当成免费会让用户按免费额度
  // 选一个按量计费的模型。
  assert.deepEqual(splitModelLabel('Trae Pro'), { name: 'Trae Pro', free: false })
  assert.equal(splitModelLabel('').weight, undefined)
})

test('model.list payloads are normalised, malformed entries dropped', () => {
  const models = readModelList({
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3 · x4.0', disabled: false, dead: false },
      { id: 'Qwen3.8-Flash', name: 'Qwen3.8-Flash · 免费', isFree: true },
      { id: 'paid', name: 'Paid · x2', isFree: true },
      { name: 'no id' },
      'garbage',
      null,
    ],
  })
  assert.deepEqual(models, [
    { id: 'MiniMax-M3', name: 'MiniMax M3', free: false, disabled: false, dead: false, weight: 4 },
    { id: 'Qwen3.8-Flash', name: 'Qwen3.8-Flash', free: true, disabled: false, dead: false, weight: 0 },
    // `isFree` 是上游的权威标记：即使展示名里写着倍率，也照上游算免费。
    { id: 'paid', name: 'Paid', free: true, disabled: false, dead: false, weight: 2 },
  ])

  assert.deepEqual(readModelList(undefined), [])
  assert.deepEqual(readModelList({ models: 'nope' }), [])
})
