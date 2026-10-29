import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AGGREGATE_REGISTRY } from '../../src/main/providers/aggregate/registry.ts'
import { chainCoverage, resolveAggregateChain } from '../../src/shared/aggregateRouting.ts'

const chain = (model: string, options?: Parameters<typeof resolveAggregateChain>[2]) =>
  resolveAggregateChain(AGGREGATE_REGISTRY, model, options)

test('a bare model name resolves across every entry that serves it', () => {
  const candidates = chain('glm-5.2')
  assert.ok(candidates.length >= 3, `expected a multi-provider chain, got ${candidates.length}`)
  const entries = candidates.map(candidate => candidate.entryId)
  for (const expected of ['glm', 'zai', 'zai_api']) {
    assert.ok(entries.includes(expected), `expected ${expected} in the chain: ${entries.join(', ')}`)
  }
  for (const candidate of candidates) {
    assert.equal(candidate.actualModelId.toLowerCase(), 'glm-5.2')
    assert.equal(candidate.displayName, `${candidate.entryId}/${candidate.actualModelId}`)
  }
})

test('a prefixed name is a pinned choice, not a chain', () => {
  assert.deepEqual(chain('glm/glm-5.2'), [], 'the user named one entry, so failover across entries would ignore that')
  assert.deepEqual(chain('openrouter/free'), [])
})

test('an unknown or retired name resolves to nothing', () => {
  assert.deepEqual(chain('definitely-not-a-model'), [])
  assert.deepEqual(chain('grok-4'), [], 'retired upstream: a chain would only find corpses')
  assert.deepEqual(chain('claude-sonnet-4-20250514'), [])
  assert.deepEqual(chain('   '), [])
})

test('matching ignores case', () => {
  assert.deepEqual(chain('GLM-5.2').map(c => c.displayName), chain('glm-5.2').map(c => c.displayName))
})

test('a stopped model drops out of the chain', () => {
  const full = chain('glm-5.2')
  const first = full[0]
  const reduced = chain('glm-5.2', {
    isServed: (entryId, modelId) => !(entryId === first.entryId && modelId === first.actualModelId),
  })
  assert.equal(reduced.length, full.length - 1)
  assert.ok(!reduced.some(c => c.entryId === first.entryId))
})

test('headroom orders the chain, and the pinned entry still wins', () => {
  const entries = chain('glm-5.2').map(c => c.entryId)
  const favourite = entries[entries.length - 1]
  const boosted = chain('glm-5.2', { headroom: entryId => (entryId === favourite ? 1 : 0) })
  assert.equal(boosted[0].entryId, favourite, 'the one with headroom goes first')

  const pinned = chain('glm-5.2', { preferredEntryId: entries[entries.length - 1] })
  assert.equal(pinned[0].entryId, entries[entries.length - 1], 'an explicit preference outranks headroom')
})

test('ties keep the catalogue order so routing stays reproducible', () => {
  const candidates = chain('glm-5.2')
  const order = AGGREGATE_REGISTRY.map(entry => entry.id)
  const indices = candidates.map(candidate => order.indexOf(candidate.entryId))
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), 'equal scores must not shuffle between requests')
})

test('coverage counts what a bare name can reach', () => {
  assert.equal(chainCoverage(AGGREGATE_REGISTRY, 'glm-5.2'), chain('glm-5.2').length)
  assert.equal(chainCoverage(AGGREGATE_REGISTRY, 'glm/glm-5.2'), 0)
})
