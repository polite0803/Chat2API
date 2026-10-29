/**
 * 供应商卡片与账号渠道页必须显示同一对账号数字。
 *
 * 回归的原始症状：某家渠道挂了 2 个号，/channels 页显示 2/2，而 /providers 页的
 * 卡片显示 1/1。原因不是缓存：渠道的真实账号池在 Worker 内，本地账号表里只有
 * `ensureLocalAccount` 建的那**一条**空凭据占位账号（供负载均衡路由用），
 * 而供应商页照本地表计数。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  localAccountCounts,
  mergeChannelCounts,
} from '../../src/renderer/src/lib/accountCounts.ts'

const channelProvider = { id: 'trae', type: 'account' }
const builtinProvider = { id: 'opencode', type: 'builtin' }

test('渠道计数取 Worker 池，覆盖本地那一条占位账号', () => {
  const providers = [channelProvider]
  const accounts = [{ providerId: 'trae', status: 'active' }]
  const local = localAccountCounts(providers, accounts)
  assert.deepEqual(local.trae, { total: 1, active: 1 }, '本地表里确实只有那一条占位账号')

  // 池里两个号、两个都启用 —— /channels 页显示的就是 2/2
  const merged = mergeChannelCounts(local, providers, { trae: { total: 2, enabled: 2 } })
  assert.deepEqual(merged.trae, { total: 2, active: 2 },
    '卡片必须跟着池子走，而不是本地占位账号')
})

test('池里被关掉的号不算「可用」，与渠道页的 enabled/total 同口径', () => {
  const providers = [channelProvider]
  const local = localAccountCounts(providers, [{ providerId: 'trae', status: 'active' }])
  const merged = mergeChannelCounts(local, providers, { trae: { total: 3, enabled: 1 } })
  assert.deepEqual(merged.trae, { total: 3, active: 1 })
})

test('非渠道供应商照本地账号表计数，不受池子影响', () => {
  const providers = [builtinProvider]
  const accounts = [
    { providerId: 'opencode', status: 'active' },
    { providerId: 'opencode', status: 'error' },
  ]
  const local = localAccountCounts(providers, accounts)
  assert.deepEqual(local.opencode, { total: 2, active: 1 })

  // 即便池子里恰好有同名键也不能覆盖：内置供应商的账号确实在本地表里
  const merged = mergeChannelCounts(local, providers, { opencode: { total: 7, enabled: 7 } })
  assert.deepEqual(merged.opencode, { total: 2, active: 1 })
})

test('池子读不到时保留本地计数，不把已连接渠道写成一无所有', () => {
  const providers = [channelProvider]
  const local = localAccountCounts(providers, [{ providerId: 'trae', status: 'active' }])
  // Worker 未启动 / provider.status 失败 → 空表
  const merged = mergeChannelCounts(local, providers, {})
  assert.deepEqual(merged.trae, { total: 1, active: 1 },
    '「读不到池子」不是「这家渠道没有账号」')
})

test('入参不被就地修改（Immutability）', () => {
  const providers = [channelProvider]
  const local = localAccountCounts(providers, [{ providerId: 'trae', status: 'active' }])
  const snapshot = structuredClone(local)
  mergeChannelCounts(local, providers, { trae: { total: 5, enabled: 5 } })
  assert.deepEqual(local, snapshot, '合并必须返回新对象，不能改掉调用方那份')
})
