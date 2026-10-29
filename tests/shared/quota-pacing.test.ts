import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  nextRollingBoundary,
  nextUtcMonthStart,
  pickBestPace,
  pickSoonestReset,
  projectReset,
  type AccountQuotaFacts,
} from '../../src/shared/quotaPacing.ts'

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0) // 2026-10-29T12:00:00Z

function facts(
  accountId: string,
  limit: AccountQuotaFacts['limit'],
  used: AccountQuotaFacts['used']
): AccountQuotaFacts {
  return { accountId, limit, used }
}

test('rolling boundaries snap to whole windows', () => {
  assert.equal(nextRollingBoundary(T0, 60_000), T0 + 60_000)
  assert.equal(nextRollingBoundary(T0 + 12_345, 60_000), T0 + 60_000, 'mid-window snaps to the same edge')
  assert.equal(nextRollingBoundary(T0, 24 * 3_600_000), Date.UTC(2026, 9, 30, 0, 0, 0))
})

test('the UTC month rolls over at the first of next month', () => {
  assert.equal(nextUtcMonthStart(T0), Date.UTC(2026, 10, 1, 0, 0, 0))
  // 月末最后一毫秒仍然指向下个月
  assert.equal(nextUtcMonthStart(Date.UTC(2026, 9, 31, 23, 59, 59, 999)), Date.UTC(2026, 10, 1, 0, 0, 0))
})

test('no enforceable cap means no projection at all', () => {
  // 推不出来就返回 undefined —— 绝不默认成"无限额度"或"立刻重置"
  assert.equal(projectReset(facts('a', {}, { rpm: 10, rpd: 99 }), T0), undefined)
  assert.equal(projectReset(facts('a', { rpm: 0 }, { rpm: 5 }), T0), undefined)
})

test('a full window wins over a healthy one and reports its own reset', () => {
  const projection = projectReset(
    facts('a', { rpm: 10, rpd: 1000 }, { rpm: 10, rpd: 5 }),
    T0
  )
  assert.ok(projection)
  assert.equal(projection!.metric, 'rpm')
  assert.equal(projection!.remaining, 0)
  assert.equal(projection!.resetAt, T0 + 60_000, 'the minute window is the one that frees this account first')
})

test('smart prefers the account that frees soonest, and pushes full ones back', () => {
  const now = T0
  const soon = facts('soon', { rpm: 10 }, { rpm: 3 })          // 有余量，1 分钟后重置
  const later = facts('later', { rpd: 100 }, { rpd: 10 })      // 有余量，24 小时后重置
  const full = facts('full', { rpm: 10 }, { rpm: 10 })         // 打满，1 分钟后重置

  // 打满的账号虽然也快重置，但此刻已经不能用，必须排在有余量的之后
  assert.equal(pickSoonestReset([full, soon, later], now), 'soon')
  assert.equal(pickSoonestReset([later, soon], now), 'soon')
})

test('smart has nothing to say when no candidate carries a cap', () => {
  assert.equal(pickSoonestReset([facts('a', {}, {}), facts('b', {}, {})], T0), undefined)
})

test('pace prefers the most remaining allowance per hour until reset', () => {
  // A：1 分钟窗口，还剩 5 → 每小时 300
  const rapid = facts('rapid', { rpm: 10 }, { rpm: 5 })
  // B：24 小时窗口，还剩 900 → 每小时 37.5
  const slow = facts('slow', { rpd: 1000 }, { rpd: 100 })

  assert.equal(pickBestPace([rapid, slow], T0), 'rapid')
  assert.equal(pickBestPace([slow, rapid], T0), 'rapid', 'order of input must not decide')
})

test('pace ignores exhausted candidates instead of picking a doomed one', () => {
  const exhausted = facts('exhausted', { rpd: 100 }, { rpd: 100 })
  const usable = facts('usable', { rpd: 100 }, { rpd: 40 })
  assert.equal(pickBestPace([exhausted, usable], T0), 'usable')
  assert.equal(pickBestPace([exhausted], T0), undefined, 'all full means no opinion, not a forced pick')
})

test('an unknown-usage account is not treated as unlimited', () => {
  // used 缺失按 0 计（= 还没用），这是账本的真实语义；但它仍然要有上限才能参与排序
  const unknownUsage = facts('u', { rpm: 10 }, {})
  const projection = projectReset(unknownUsage, T0)
  assert.equal(projection!.remaining, 10)
  assert.equal(pickBestPace([unknownUsage], T0), 'u')
})
