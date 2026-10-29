import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeAutoRoutingConfig } from '../../src/main/store/autoRoutingConfig.ts'
import { DEFAULT_AUTO_ROUTING_CONFIG } from '../../src/shared/types.ts'

test('a missing config uses the shipped defaults, including the preference', () => {
  assert.deepEqual(normalizeAutoRoutingConfig(undefined), DEFAULT_AUTO_ROUTING_CONFIG)
  assert.equal(normalizeAutoRoutingConfig({}).prefer, 'balanced')
})

test('numeric fields are clamped instead of trusted', () => {
  assert.equal(normalizeAutoRoutingConfig({ maxAttempts: 99 }).maxAttempts, 5)
  assert.equal(normalizeAutoRoutingConfig({ maxAttempts: 0 }).maxAttempts, 1)
  assert.equal(normalizeAutoRoutingConfig({ stickyMinutes: -30 }).stickyMinutes, 0)
  assert.equal(normalizeAutoRoutingConfig({ stickyMinutes: 99_999 }).stickyMinutes, 1440)
})

test('an unknown preference falls back to balanced instead of reaching the router', () => {
  // 手写 data.json 里的任意字符串都不能让路由进入未定义分支
  const normalized = normalizeAutoRoutingConfig({ prefer: 'turbo' as never })
  assert.equal(normalized.prefer, 'balanced')
  assert.equal(normalizeAutoRoutingConfig({ prefer: 'cheap' }).prefer, 'cheap')
})
