/**
 * models.dev 第三方能力旁表（`shared/aggregateCapabilities.ts`）的契约测试。
 *
 * 旁表是能力解析里最低的一层自动证据，生成脚本按**完全相同的 baseUrl** 对齐条目，
 * 只收 `tool_call: true` / `reasoning: true` 这类肯定证据。这里钉住的是「它没有
 * 越界」：每条行都能在目录里找到，每个模型 id 都真实存在，且写进去的值形状合法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGGREGATE_CAPABILITIES,
  aggregateThirdPartyHint,
} from '../../src/shared/aggregateCapabilities.ts'
import { AGGREGATE_REGISTRY, getAggregateEntry } from '../../src/main/providers/aggregate/registry.ts'
import type { InputModality } from '../../src/shared/types.ts'

const MODALITIES = new Set<InputModality>(['text', 'image', 'audio', 'video', 'pdf'])

test('每条旁表行都对应一个在册条目，模型 id 也都在该条目里', () => {
  for (const [entryId, row] of Object.entries(AGGREGATE_CAPABILITIES)) {
    const entry = getAggregateEntry(entryId)
    assert.ok(entry, `${entryId} 不在聚合目录里`)

    const ids = new Set(entry.models.map(model => model.id))
    for (const modelId of Object.keys(row.models)) {
      assert.ok(ids.has(modelId), `${entryId}/${modelId} 不在条目模型表里`)
    }
    assert.ok(row.modelsDevProviderId.length > 0, `${entryId} 缺少对齐到的 models.dev 供应商 id`)
  }
})

test('行里的能力值形状合法：只有肯定证据，模态与窗口都合理', () => {
  for (const [entryId, row] of Object.entries(AGGREGATE_CAPABILITIES)) {
    for (const [modelId, hint] of Object.entries(row.models)) {
      const label = `${entryId}/${modelId}`
      // 只收肯定证据：false 与 unknown 不写
      if (hint.tools !== undefined) assert.equal(hint.tools, 'yes', label)
      if (hint.reasoning !== undefined) assert.equal(hint.reasoning, 'yes', label)
      if (hint.vision !== undefined) assert.equal(hint.vision, 'yes', label)
      // 没有 tier / weight / free —— 那些不是 models.dev 能回答的问题
      assert.equal(hint.tier, undefined, label)
      assert.equal(hint.weight, undefined, label)
      assert.equal(hint.free, undefined, label)

      if (hint.modalities !== undefined) {
        assert.ok(hint.modalities.length > 0, label)
        for (const modality of hint.modalities) {
          assert.ok(MODALITIES.has(modality), `${label}: 未知模态 ${modality}`)
        }
      }
      if (hint.contextTokens !== undefined) {
        assert.ok(Number.isInteger(hint.contextTokens) && hint.contextTokens > 0, label)
      }
      assert.ok(Object.keys(hint).length > 0, `${label}: 空标注不应写进旁表`)
    }
  }
})

test('旁表确实覆盖了能力维度（不是一张空表）', () => {
  const rows = Object.values(AGGREGATE_CAPABILITIES)
  assert.ok(rows.length >= 10, '旁表条目太少，说明 baseUrl 对齐可能整体失效')

  const hints = rows.flatMap(row => Object.values(row.models))
  assert.ok(hints.some(hint => hint.tools === 'yes'), '没有任何 tools 证据')
  assert.ok(hints.some(hint => hint.reasoning === 'yes'), '没有任何 reasoning 证据')
  assert.ok(hints.some(hint => hint.contextTokens !== undefined), '没有任何上下文窗口')
})

test('查不到时返回 undefined，而不是空对象', () => {
  assert.equal(aggregateThirdPartyHint('not-an-entry', 'x'), undefined)
  assert.equal(aggregateThirdPartyHint('glm', 'not-a-model'), undefined)

  const known = Object.keys(AGGREGATE_CAPABILITIES)[0]!
  const modelId = Object.keys(AGGREGATE_CAPABILITIES[known]!.models)[0]!
  assert.deepEqual(
    aggregateThirdPartyHint(known, modelId),
    AGGREGATE_CAPABILITIES[known]!.models[modelId]
  )
})

test('旁表不会凭空给目录里不存在的条目建行', () => {
  const known = new Set(AGGREGATE_REGISTRY.map(entry => entry.id))
  for (const entryId of Object.keys(AGGREGATE_CAPABILITIES)) {
    assert.ok(known.has(entryId), `${entryId} 被 withdraw 后旁表没重建`)
  }
})
