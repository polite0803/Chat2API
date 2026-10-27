import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AccountRuntime } from '../../src/main/proxy/accountRuntime.ts'

const NOW = 1_800_000_000_000

test('tracks in-flight requests and a sliding minute window', () => {
  const runtime = new AccountRuntime()

  runtime.beginAttempt('a', NOW)
  runtime.beginAttempt('a', NOW + 1000)

  const snapshot = runtime.snapshot('a', NOW + 2000)
  assert.equal(snapshot.inFlight, 2)
  assert.equal(snapshot.rpmUsed, 2)

  runtime.endAttempt('a')
  runtime.endAttempt('a')
  runtime.endAttempt('a')
  assert.equal(runtime.snapshot('a', NOW + 2000).inFlight, 0)

  // 窗口滑出后 RPM 归零
  assert.equal(runtime.snapshot('a', NOW + 62_000).rpmUsed, 0)
})

test('429 backoff escalates exponentially and resets after a success', () => {
  const runtime = new AccountRuntime()

  assert.equal(runtime.recordFailure('a', 429, NOW), 60_000)
  assert.equal(runtime.isCooling('a', NOW + 1000), true)
  assert.equal(runtime.isCooling('a', NOW + 61_000), false)

  assert.equal(runtime.recordFailure('a', 429, NOW + 2000), 120_000)
  assert.equal(runtime.recordFailure('a', 429, NOW + 3000), 240_000)

  runtime.recordSuccess('a')
  assert.equal(runtime.snapshot('a', NOW + 4000).consecutiveFailures, 0)
  assert.equal(runtime.isCooling('a', NOW + 4000), false)
})

test('non-429 failures use the shorter backoff and cap at two minutes', () => {
  const runtime = new AccountRuntime()

  assert.equal(runtime.recordFailure('a', 500, NOW), 15_000)
  assert.equal(runtime.recordFailure('a', undefined, NOW + 1), 30_000) // 网络错误按 5xx 口径

  for (let i = 0; i < 6; i++) {
    runtime.recordFailure('a', 500, NOW + 2 + i)
  }

  const snapshot = runtime.snapshot('a', NOW + 10)
  assert.equal(snapshot.coolingUntil, NOW + 7 + 120_000)
  assert.ok(snapshot.consecutiveFailures >= 3)
})

test('unknown accounts report neutral metrics', () => {
  const runtime = new AccountRuntime()

  assert.deepEqual(runtime.snapshot('missing', NOW), {
    inFlight: 0,
    rpmUsed: 0,
    consecutiveFailures: 0,
  })
  assert.equal(runtime.isCooling('missing', NOW), false)
})
