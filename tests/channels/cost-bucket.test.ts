import { test } from 'node:test'
import assert from 'node:assert/strict'

import { costBucketOf } from '../../src/shared/channels.ts'

test('a zero or missing-but-free weight is the free bucket', () => {
  assert.equal(costBucketOf(0, true), 'free')
  assert.equal(costBucketOf(undefined, true), 'free')
})

test('weights under the 1x base fall below it', () => {
  for (const weight of [0.1, 0.2, 0.99]) {
    assert.equal(costBucketOf(weight, false), 'below-base', `weight ${weight}`)
  }
})

test('exactly 1x is the base bucket', () => {
  assert.equal(costBucketOf(1, false), 'base')
})

test('weights above the base fall above it', () => {
  for (const weight of [1.01, 2, 4]) {
    assert.equal(costBucketOf(weight, false), 'above-base', `weight ${weight}`)
  }
})

test('an unreported weight never folds into a paid bucket', () => {
  const bucket = costBucketOf(undefined, false)
  assert.equal(bucket, 'unknown')
  assert.notEqual(bucket, 'base')
  assert.notEqual(bucket, 'above-base')
})

test('a malformed negative weight is treated as free, not as below-base', () => {
  assert.equal(costBucketOf(-1, false), 'free')
})
