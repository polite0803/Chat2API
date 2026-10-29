import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { ChatMessage } from '../../src/main/proxy/types.ts'
import {
  pickLiveZone,
  readLiveZoneText,
  replaceLiveZoneText,
} from '../../src/main/proxy/compression/liveZone.ts'

function msg(role: ChatMessage['role'], content: ChatMessage['content']): ChatMessage {
  return { role, content }
}

test('only the newest tool and user messages are eligible', () => {
  const messages: ChatMessage[] = [
    msg('system', 'system prompt that must never move'),
    msg('user', '[{"a":1},{"a":2}]'.repeat(40)),
    msg('assistant', 'previous answer'),
    msg('tool', '[{"hit":1},{"hit":2}]'.repeat(40)),
    msg('user', 'now summarise the output above'),
  ]

  const targets = pickLiveZone(messages)
  const indices = targets.map(target => target.messageIndex).sort((a, b) => a - b)

  // Index 1 is an EARLIER user message and 2 is an assistant message: both frozen.
  assert.deepEqual(indices, [3, 4])
  assert.equal(targets.find(target => target.messageIndex === 3)?.kind, 'tool')
  assert.equal(targets.find(target => target.messageIndex === 4)?.kind, 'user')
})

test('a user message an assistant already answered is frozen', () => {
  // No tool message at all: the only user turn has been answered, so the whole
  // history is cache-resident and nothing may be rewritten.
  const messages: ChatMessage[] = [
    msg('user', '[{"a":1},{"a":2}]'.repeat(40)),
    msg('assistant', 'here is the summary'),
  ]

  assert.deepEqual(pickLiveZone(messages), [])
})

test('a request with no tool or user message has no live zone', () => {
  assert.deepEqual(pickLiveZone([msg('system', 'only a system prompt')]), [])
  assert.deepEqual(pickLiveZone([]), [])
  assert.deepEqual(pickLiveZone(undefined), [])
})

test('assistant tool_calls are never a compression target', () => {
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'grep', arguments: '{"pattern":"x"}' } },
      ],
    },
    msg('tool', '{"result":"ok"}'),
  ]

  const targets = pickLiveZone(messages)
  // Only the tool result; the assistant message carrying tool_calls is frozen.
  assert.deepEqual(targets.map(target => target.messageIndex), [1])
})

test('multimodal user content exposes text parts only', () => {
  const messages: ChatMessage[] = [
    msg('user', [
      { type: 'text', text: 'look at this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]),
  ]

  const targets = pickLiveZone(messages)
  assert.equal(targets.length, 1)
  assert.equal(targets[0].partIndex, 0)
  assert.equal(readLiveZoneText(messages, targets[0]), 'look at this')
})

test('replacing one target leaves every other message object identical', () => {
  const messages: ChatMessage[] = [
    msg('system', 'frozen system'),
    msg('user', 'frozen earlier user'),
    msg('assistant', 'frozen assistant'),
    msg('tool', '[{"a":1},{"a":2},{"a":3}]'),
  ]

  const targets = pickLiveZone(messages)
  assert.equal(targets.length, 1)

  const next = replaceLiveZoneText(messages, targets[0], '[{"a":1}]')
  assert.notEqual(next, messages)
  assert.equal(readLiveZoneText(next, targets[0]), '[{"a":1}]')

  // Object identity is the cache-safety guarantee: untouched messages cannot
  // serialize differently because they are the very same objects.
  assert.equal(next[0], messages[0])
  assert.equal(next[1], messages[1])
  assert.equal(next[2], messages[2])
  assert.notEqual(next[3], messages[3])

  // The original array is not mutated (repository immutability rule).
  assert.equal(messages[3].content, '[{"a":1},{"a":2},{"a":3}]')
})

test('replacing a text part keeps the image part untouched', () => {
  const messages: ChatMessage[] = [
    msg('user', [
      { type: 'text', text: 'old' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]),
  ]

  const targets = pickLiveZone(messages)
  const next = replaceLiveZoneText(messages, targets[0], 'new')

  const parts = next[0].content
  assert.ok(Array.isArray(parts))
  assert.equal(parts[0].text, 'new')
  assert.equal(parts[1], (messages[0].content as unknown[])[1])
})
