import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '../../src/main/proxy/types.ts'
import {
  applyVerbositySteering,
  steeringBlock,
  replaceOrAppendBlock,
  stripBlock,
  STEERING_SENTINEL_OPEN,
  STEERING_SENTINEL_CLOSE,
  MAX_VERBOSITY_LEVEL,
} from '../../src/main/proxy/compression/outputSteering.ts'

function msg(role: ChatMessage['role'], content: ChatMessage['content']): ChatMessage {
  return { role, content }
}

test('level 0 produces no block, and every level 1..3 produces one', () => {
  assert.equal(steeringBlock(0), null)
  for (let level = 1; level <= MAX_VERBOSITY_LEVEL; level += 1) {
    const block = steeringBlock(level)
    assert.ok(block)
    assert.ok(block!.includes(STEERING_SENTINEL_OPEN))
    assert.ok(block!.includes(STEERING_SENTINEL_CLOSE))
  }
  // An unknown level must not invent text either.
  assert.equal(steeringBlock(99), null)
})

test('the block is byte-stable for a given level', () => {
  // Cache friendliness depends on this: identical input, identical output.
  for (let level = 1; level <= MAX_VERBOSITY_LEVEL; level += 1) {
    assert.equal(steeringBlock(level), steeringBlock(level))
  }
})

test('applying the block twice changes nothing the second time', () => {
  const block = steeringBlock(2)!
  const messages: ChatMessage[] = [
    msg('system', 'You are a coding agent.'),
    msg('user', 'refactor this file'),
  ]

  const first = applyVerbositySteering(messages, 2)
  assert.equal(first.changed, true)

  const second = applyVerbositySteering(first.messages, 2)
  assert.equal(second.changed, false)
  // Idempotent means the very same array comes back, not just equal content.
  assert.equal(second.messages, first.messages)
})

test('the block lands at the tail of the system message, not the front', () => {
  const messages: ChatMessage[] = [msg('system', 'You are a coding agent.')]
  const applied = applyVerbositySteering(messages, 1)
  const content = applied.messages[0].content as string

  assert.ok(content.startsWith('You are a coding agent.'))
  assert.ok(content.trimEnd().endsWith(STEERING_SENTINEL_CLOSE))
})

test('only the system message is touched', () => {
  const messages: ChatMessage[] = [
    msg('system', 'You are a coding agent.'),
    msg('user', 'refactor this file'),
    msg('assistant', 'sure'),
    msg('tool', '{"ok":true}'),
  ]

  const applied = applyVerbositySteering(messages, 3)

  // The three non-system messages keep their object identity, so nothing the
  // model treats as evidence can drift.
  assert.equal(applied.messages[1], messages[1])
  assert.equal(applied.messages[2], messages[2])
  assert.equal(applied.messages[3], messages[3])
  assert.notEqual(applied.messages[0], messages[0])
})

test('the LAST system message is the one extended', () => {
  // A conversation may carry several system turns; the tail one is the one the
  // model reads last, so that is where a style hint belongs.
  const messages: ChatMessage[] = [
    msg('system', 'first system turn'),
    msg('user', 'question'),
    msg('system', 'second system turn'),
  ]

  const applied = applyVerbositySteering(messages, 1)
  assert.equal(applied.messages[0], messages[0])
  assert.ok((applied.messages[2].content as string).includes(STEERING_SENTINEL_OPEN))
})

test('a request with no system message gets one at the front', () => {
  const messages: ChatMessage[] = [msg('user', 'hello')]
  const applied = applyVerbositySteering(messages, 2)

  assert.equal(applied.changed, true)
  assert.equal(applied.messages.length, 2)
  assert.equal(applied.messages[0].role, 'system')
  assert.ok((applied.messages[0].content as string).includes(STEERING_SENTINEL_OPEN))
  // The original turn is preserved untouched.
  assert.equal(applied.messages[1], messages[0])
})

test('changing level replaces the block instead of stacking a second one', () => {
  const messages: ChatMessage[] = [msg('system', 'base prompt')]

  const level2 = applyVerbositySteering(messages, 2)
  const level3 = applyVerbositySteering(level2.messages, 3)

  const content = level3.messages[0].content as string
  const occurrences = content.split(STEERING_SENTINEL_OPEN).length - 1
  assert.equal(occurrences, 1)
  assert.ok(content.includes(steeringBlock(3)!))
  assert.ok(!content.includes(steeringBlock(2)!))
})

test('level 0 removes the block and restores the original prompt exactly', () => {
  const original = 'You are a coding agent.'
  const applied = applyVerbositySteering([msg('system', original)], 3).messages
  const removed = applyVerbositySteering(applied, 0)

  assert.equal(removed.changed, true)
  assert.equal(removed.messages[0].content, original)
})

test('level 0 on a prompt that never had the block is a no-op', () => {
  const messages: ChatMessage[] = [msg('system', 'plain prompt')]
  const result = applyVerbositySteering(messages, 0)

  assert.equal(result.changed, false)
  assert.equal(result.messages, messages)
})

test('removing the block never eats text that surrounds it', () => {
  const withSurrounding = `before\n\n${steeringBlock(1)!}\n\nafter`
  assert.equal(stripBlock(withSurrounding), 'before\n\nafter')
})

test('multimodal system content gets a text part appended', () => {
  const messages: ChatMessage[] = [
    msg('system', [{ type: 'text', text: 'base prompt' }]),
  ]

  const applied = applyVerbositySteering(messages, 2)
  assert.equal(applied.changed, true)

  const parts = applied.messages[0].content
  assert.ok(Array.isArray(parts))
  assert.equal(parts.length, 2)
  assert.equal((parts[1] as { text?: string }).text, steeringBlock(2))
})

test('an empty message list is left alone', () => {
  assert.equal(applyVerbositySteering([], 3).changed, false)
  assert.equal(applyVerbositySteering(undefined, 3).changed, false)
})

test('a null system content is not turned into text', () => {
  const messages: ChatMessage[] = [msg('system', null), msg('user', 'hi')]
  const result = applyVerbositySteering(messages, 2)

  assert.equal(result.changed, false)
  assert.equal(result.messages[0].content, null)
})

test('appending twice directly through the helper is still single', () => {
  const block = steeringBlock(1)!
  const once = replaceOrAppendBlock('base', block)
  const twice = replaceOrAppendBlock(once, block)
  assert.equal(once, twice)
  assert.equal(twice.split(STEERING_SENTINEL_OPEN).length - 1, 1)
})
