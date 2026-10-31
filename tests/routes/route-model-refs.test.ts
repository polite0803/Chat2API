/**
 * 路由手动增删（`includeModels` / `excludeModels`）的归一与写入校验测试。
 *
 * 规则与其它路由字段相反，值得单独钉住：
 * - 非法条目**整条丢弃**（补默认值只会指向错误模型）；
 * - 去重按 providerId + displayName 的大小写不敏感形式，保留第一次出现的大小写；
 * - 写入侧只校验结构，不按目录拒绝 —— 一条陈旧引用不能让之后的所有编辑都 400；
 * - 缺省键归一成空数组，PATCH 语义里 undefined 表示沿用、[] 表示清空。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkRouteModelRefs,
  mergeRouteTables,
  normalizeModelRoutes,
  normalizeRouteModelRefs,
  validateRoutesForWrite,
} from '../../src/main/store/modelRoutes.ts'

test('归一：trim、丢空条目、大小写不敏感去重且保留第一次的大小写', () => {
  assert.deepEqual(
    normalizeRouteModelRefs([
      { providerId: ' glm ', displayName: ' glm/glm-5.3 ' },
      { providerId: 'GLM', displayName: 'GLM/GLM-5.3' },
      { providerId: '', displayName: 'x' },
      { providerId: 'glm', displayName: '   ' },
      { displayName: 'only-name' },
      'not-an-object',
      null,
    ]),
    [{ providerId: 'glm', displayName: 'glm/glm-5.3' }]
  )
})

test('归一：非数组输入得到空数组（缺失 ≠ 保留旧值，消费方统一按空处理）', () => {
  assert.deepEqual(normalizeRouteModelRefs(undefined), [])
  assert.deepEqual(normalizeRouteModelRefs({ providerId: 'glm' }), [])
  assert.deepEqual(normalizeRouteModelRefs('glm/model'), [])
})

test('归一：条目数量有上界（手工配置不能把候选池预览拖死）', () => {
  const many = Array.from({ length: 2500 }, (_, index) => ({
    providerId: 'p',
    displayName: `model-${index}`,
  }))

  assert.equal(normalizeRouteModelRefs(many).length, 2000)
})

test('读侧归一：缺失时得到空数组，写进去的值原样保留', () => {
  const normalized = normalizeModelRoutes({
    fast: { includeModels: [{ providerId: 'glm', displayName: 'glm/glm-5.3' }] },
  })

  assert.deepEqual(normalized.fast.includeModels, [{ providerId: 'glm', displayName: 'glm/glm-5.3' }])
  assert.deepEqual(normalized.fast.excludeModels, [])
})

test('写入校验：只校验结构，不校验模型是否还在目录里', () => {
  assert.equal(checkRouteModelRefs('includeModels', undefined), undefined)
  assert.equal(
    checkRouteModelRefs('includeModels', [{ providerId: 'gone', displayName: 'deleted-model' }]),
    undefined,
    '陈旧引用必须放行，否则任何一次无关编辑都会永久 400'
  )

  const error = checkRouteModelRefs('excludeModels', [{ providerId: 'glm' }])
  assert.equal(error?.code, 'invalid_input')
  assert.match(error?.message ?? '', /excludeModels/)

  assert.equal(checkRouteModelRefs('includeModels', 'glm/model')?.code, 'invalid_input')
})

test('整表写入校验会把结构错误报出来', () => {
  const errors = validateRoutesForWrite(
    { fast: { includeModels: [{ providerId: '', displayName: 'x' }] } },
    {},
    { modelNames: [], aliases: [] }
  )

  assert.match(errors.join('\n'), /includeModels/)
})

test('PATCH 语义：undefined 沿用旧值，[] 才是清空', () => {
  const base = normalizeModelRoutes({
    fast: {
      includeModels: [{ providerId: 'glm', displayName: 'glm/glm-5.3' }],
      excludeModels: [{ providerId: 'kimi', displayName: 'kimi/K2' }],
    },
  })

  const kept = mergeRouteTables(base, { fast: { maxAttempts: 2 } })
  assert.deepEqual(kept.fast.includeModels, [{ providerId: 'glm', displayName: 'glm/glm-5.3' }])
  assert.deepEqual(kept.fast.excludeModels, [{ providerId: 'kimi', displayName: 'kimi/K2' }])

  const cleared = mergeRouteTables(base, { fast: { includeModels: [], excludeModels: [] } })
  assert.deepEqual(cleared.fast.includeModels, [])
  assert.deepEqual(cleared.fast.excludeModels, [])
})
