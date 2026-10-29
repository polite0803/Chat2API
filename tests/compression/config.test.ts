import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCompressionConfig } from '../../src/main/store/compressionConfig.ts'
import { normalizeOutputSteeringConfig } from '../../src/main/store/outputSteeringConfig.ts'
import { DEFAULT_COMPRESSION_CONFIG, DEFAULT_OUTPUT_STEERING_CONFIG } from '../../src/shared/types.ts'

test('an install from before the feature reads as disabled', () => {
  // `data.json` written by a release that had no `compression` key at all.
  assert.deepEqual(normalizeCompressionConfig(undefined), { ...DEFAULT_COMPRESSION_CONFIG })
  assert.equal(normalizeCompressionConfig(null).enabled, false)
})

test('only an explicit true enables compression', () => {
  assert.equal(normalizeCompressionConfig({ enabled: true }).enabled, true)
  assert.equal(normalizeCompressionConfig({ enabled: false }).enabled, false)
  // Defensive: a hand-edited truthy non-boolean must not switch it on.
  assert.equal(normalizeCompressionConfig({ enabled: 'yes' as never }).enabled, false)
})

test('an unrecognised strength falls back to the default', () => {
  assert.equal(
    normalizeCompressionConfig({ aggressiveness: 'turbo' as never }).aggressiveness,
    DEFAULT_COMPRESSION_CONFIG.aggressiveness
  )
  assert.equal(normalizeCompressionConfig({ aggressiveness: 'aggressive' }).aggressiveness, 'aggressive')
  assert.equal(normalizeCompressionConfig({ aggressiveness: 'conservative' }).aggressiveness, 'conservative')
})

test('normalisation returns a fresh object and never mutates the input', () => {
  const input = { enabled: true, aggressiveness: 'moderate' as const }
  const normalized = normalizeCompressionConfig(input)
  assert.notEqual(normalized, input)
  normalized.enabled = false
  assert.equal(input.enabled, true)
})

test('output steering reads as disabled on an install from before it', () => {
  assert.deepEqual(normalizeOutputSteeringConfig(undefined), { ...DEFAULT_OUTPUT_STEERING_CONFIG })
  assert.equal(normalizeOutputSteeringConfig(null).enabled, false)
})

test('only an explicit true enables output steering', () => {
  assert.equal(normalizeOutputSteeringConfig({ enabled: true, level: 2 }).enabled, true)
  assert.equal(normalizeOutputSteeringConfig({ enabled: 'yes' as never, level: 2 }).enabled, false)
})

test('the steering level is clamped to a level that has text', () => {
  // A stored 0 or 99 must never reach the applier: level 0 means "off" and an
  // unknown level has no text, so both collapse to the default.
  assert.equal(normalizeOutputSteeringConfig({ enabled: true, level: 0 }).level, DEFAULT_OUTPUT_STEERING_CONFIG.level)
  assert.equal(normalizeOutputSteeringConfig({ enabled: true, level: 99 }).level, DEFAULT_OUTPUT_STEERING_CONFIG.level)
  assert.equal(normalizeOutputSteeringConfig({ enabled: true, level: 3 }).level, 3)
  assert.equal(normalizeOutputSteeringConfig({ enabled: true, level: 1 }).level, 1)
})
