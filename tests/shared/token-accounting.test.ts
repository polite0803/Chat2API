import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  accumulateDayBucket,
  summarizeDay,
  trimDays,
  normalizeDayBucket,
  tokenDayKey,
  type DayTokenBucket,
} from '../../src/shared/tokenAccounting.ts'

test('an empty bucket reports a null coverage, not zero', () => {
  const summary = summarizeDay('2026-10-29', normalizeDayBucket(undefined))

  assert.equal(summary.upstreamCoverage, null)
  assert.equal(summary.requests, 0)
  assert.equal(summary.savedTokens, 0)
})

test('upstream and estimated tokens never pollute each other', () => {
  // This is the rule the dashboard depends on: the two pools must stay separate,
  // because only the upstream pool could ever match a bill.
  let bucket: DayTokenBucket | undefined

  bucket = accumulateDayBucket(bucket, {
    promptTokens: 1000,
    completionTokens: 500,
    source: 'upstream',
  })
  bucket = accumulateDayBucket(bucket, {
    promptTokens: 800,
    completionTokens: 200,
    source: 'estimated',
  })

  const summary = summarizeDay('2026-10-29', bucket)

  assert.equal(summary.upstreamPrompt, 1000)
  assert.equal(summary.upstreamCompletion, 500)
  assert.equal(summary.estimatedPrompt, 800)
  assert.equal(summary.estimatedCompletion, 200)
  assert.equal(summary.requests, 2)
  assert.equal(summary.upstreamRequests, 1)
  assert.equal(summary.upstreamCoverage, 0.5)
})

test('a day where every request reported usage has full coverage', () => {
  let bucket: DayTokenBucket | undefined
  bucket = accumulateDayBucket(bucket, { promptTokens: 10, completionTokens: 5, source: 'upstream' })
  bucket = accumulateDayBucket(bucket, { promptTokens: 20, completionTokens: 8, source: 'upstream' })

  const summary = summarizeDay('2026-10-29', bucket)
  assert.equal(summary.upstreamCoverage, 1)
  assert.equal(summary.estimatedPrompt, 0)
  assert.equal(summary.estimatedCompletion, 0)
})

test('a day where nothing reported usage has zero coverage, not null', () => {
  // Two requests WERE recorded, so the ratio is known: 0%. Null would mean
  // "nothing recorded at all", which is a different fact.
  const bucket = accumulateDayBucket(undefined, {
    promptTokens: 100,
    completionTokens: 40,
    source: 'estimated',
  })

  const summary = summarizeDay('2026-10-29', bucket)
  assert.equal(summary.upstreamCoverage, 0)
  assert.equal(summary.upstreamPrompt, 0)
})

test('savings accumulate only from requests that supply them', () => {
  let bucket: DayTokenBucket | undefined
  bucket = accumulateDayBucket(bucket, {
    promptTokens: 100,
    completionTokens: 50,
    source: 'upstream',
    savedTokens: 900,
  })
  bucket = accumulateDayBucket(bucket, {
    promptTokens: 100,
    completionTokens: 50,
    source: 'upstream',
  })

  assert.equal(summaryOf(bucket).savedTokens, 900)
})

test('negative and non-finite input is floored to zero', () => {
  // A upstream that reports garbage must not corrupt the day's totals.
  const bucket = accumulateDayBucket(undefined, {
    promptTokens: -5,
    completionTokens: Number.NaN,
    source: 'upstream',
    savedTokens: -1,
  })

  assert.equal(bucket.upstreamPrompt, 0)
  assert.equal(bucket.upstreamCompletion, 0)
  assert.equal(bucket.savedTokens, 0)
  assert.equal(bucket.requests, 1)
})

test('accumulation never mutates the bucket it is given', () => {
  const original: DayTokenBucket = normalizeDayBucket({ upstreamPrompt: 500, requests: 1 })
  const before = JSON.stringify(original)

  const next = accumulateDayBucket(original, {
    promptTokens: 100,
    completionTokens: 10,
    source: 'upstream',
  })

  assert.equal(JSON.stringify(original), before)
  assert.notEqual(next, original)
  assert.equal(next.upstreamPrompt, 600)
})

test('trimming keeps the newest days and drops the rest', () => {
  const buckets: Record<string, DayTokenBucket> = {}
  for (let day = 1; day <= 30; day += 1) {
    const key = `2026-10-${String(day).padStart(2, '0')}`
    buckets[key] = normalizeDayBucket({ requests: day })
  }

  const trimmed = trimDays(buckets, 10)
  const keys = Object.keys(trimmed).sort()

  assert.equal(keys.length, 10)
  assert.equal(keys[0], '2026-10-21')
  assert.equal(keys[9], '2026-10-30')
})

test('trimming a small map returns it unchanged', () => {
  const buckets = { '2026-10-29': normalizeDayBucket({ requests: 1 }) }
  assert.deepEqual(trimDays(buckets, 10), buckets)
})

test('a hand-edited persisted bucket is sanitized', () => {
  const poisoned = normalizeDayBucket({
    upstreamPrompt: -1,
    upstreamCompletion: 'abc',
    estimatedPrompt: Number.POSITIVE_INFINITY,
    savedTokens: 1e999,
    requests: 2.7,
    upstreamRequests: null,
  })

  assert.equal(poisoned.upstreamPrompt, 0)
  assert.equal(poisoned.upstreamCompletion, 0)
  assert.equal(poisoned.estimatedPrompt, 0)
  assert.equal(poisoned.savedTokens, 0)
  assert.equal(poisoned.requests, 2)
  assert.equal(poisoned.upstreamRequests, 0)
  assert.equal(poisoned.upstreamCacheRead, 0, 'a field added later must sanitize to 0, not stay undefined')
})

test('cache reads enter the day only from upstream-reported usage', () => {
  // 估算请求不可能"带来"缓存命中：写了就是把"没测到"伪装成"测到了"。
  let bucket: DayTokenBucket | undefined
  bucket = accumulateDayBucket(bucket, { promptTokens: 1000, completionTokens: 10, source: 'upstream', cacheReadTokens: 900 })
  bucket = accumulateDayBucket(bucket, { promptTokens: 800, completionTokens: 10, source: 'estimated', cacheReadTokens: 500 })

  const summary = summaryOf(bucket)
  assert.equal(summary.upstreamCacheRead, 900)
  assert.equal(summary.upstreamPrompt, 1000, 'cache reads are a subset of the reported input, never an extra pool')
})

test('a bucket persisted before the cache field existed cannot poison the day', () => {
  // ⚠️ 真正的回归围栏：调用方喂给 `accumulateDayBucket` 的是**磁盘上读出来**的
  // 对象。旧 `data.json` 里没有 `upstreamCacheRead`，过去直接 `base.field + x`
  // 会算出 `NaN` 并写回存储，从此这一天所有计数都不可显示。
  const legacy = {
    upstreamPrompt: 500,
    upstreamCompletion: 10,
    estimatedPrompt: 0,
    estimatedCompletion: 0,
    savedTokens: 0,
    requests: 1,
    upstreamRequests: 1,
  } as unknown as DayTokenBucket

  const next = accumulateDayBucket(legacy, { promptTokens: 100, completionTokens: 5, source: 'upstream' })

  assert.equal(next.upstreamCacheRead, 0)
  assert.equal(next.upstreamPrompt, 600)
  assert.ok(Number.isFinite(next.upstreamPrompt) && Number.isFinite(next.upstreamCacheRead))
})

test('the day key is the local calendar day', () => {
  // 23:30 local on the 29th is still the 29th, never the 30th.
  const lateEvening = new Date(2026, 9, 29, 23, 30, 0).getTime()
  const earlyMorning = new Date(2026, 9, 29, 0, 30, 0).getTime()

  assert.equal(tokenDayKey(lateEvening), '2026-10-29')
  assert.equal(tokenDayKey(earlyMorning), '2026-10-29')
})

/** Local helper so the savings test reads at a glance. */
function summaryOf(bucket: DayTokenBucket) {
  return summarizeDay('2026-10-29', bucket)
}
