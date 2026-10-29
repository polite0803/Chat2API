import test from 'node:test'
import assert from 'node:assert/strict'

import { dayCountsOf, differenceInPoints, isolatedIndices, percentChange, successRateOf } from '../../src/shared/trendMath.ts'

test('a comparison with an unknown side is null, never 0%', () => {
  assert.equal(percentChange(null, 10), null)
  assert.equal(percentChange(10, null), null)
  assert.equal(percentChange(null, null), null)
  assert.equal(percentChange(15, 10), 50)
  assert.equal(percentChange(5, 10), -50)
})

test('a genuine zero base still reads as new traffic', () => {
  assert.equal(percentChange(4, 0), 100)
  assert.equal(percentChange(0, 0), 0)
})

test('a success-rate difference needs both days measured', () => {
  assert.equal(differenceInPoints(90, 80), 10)
  assert.equal(differenceInPoints(90, null), null)
  assert.equal(differenceInPoints(null, 80), null)
})

test('request-log days carry latency, app-log days do not', () => {
  assert.deepEqual(
    dayCountsOf({ date: '2026-10-29', total: 10, success: 8, error: 2, avgLatency: 300 }, true),
    { requests: 10, success: 8, avgLatency: 300 },
  )
  assert.deepEqual(
    dayCountsOf({ date: '2026-10-29', total: 10, info: 9, warn: 1, error: 0 }, false),
    { requests: 10, success: 9, avgLatency: null },
  )
  assert.deepEqual(dayCountsOf(undefined, true), { requests: null, success: null, avgLatency: null })
  assert.deepEqual(
    dayCountsOf({ date: '2026-10-22', total: null, success: null, error: null, avgLatency: null }, true),
    { requests: null, success: null, avgLatency: null },
  )
})

test('a day with no requests has no success rate', () => {
  assert.equal(successRateOf({ requests: 0, success: 0, avgLatency: 0 }), null)
  assert.equal(successRateOf({ requests: null, success: null, avgLatency: null }), null)
  assert.equal(successRateOf({ requests: 3, success: 2, avgLatency: 100 }), 67)
})

test('a lone retained day is a marker, not an invisible path', () => {
  // The whole window survives on one day: a path of one point paints nothing.
  assert.deepEqual(isolatedIndices([null, null, null, null, null, null, 200]), [6])
  assert.deepEqual(isolatedIndices([7]), [0])
  assert.deepEqual(isolatedIndices([5, null, 7, null, 9]), [0, 2, 4])
})

test('neighbouring days keep the line and need no marker', () => {
  assert.deepEqual(isolatedIndices([1, 2, 3]), [])
  assert.deepEqual(isolatedIndices([null, 2, 3, null]), [])
  assert.deepEqual(isolatedIndices([null, null, null]), [])
  assert.deepEqual(isolatedIndices([]), [])
})
