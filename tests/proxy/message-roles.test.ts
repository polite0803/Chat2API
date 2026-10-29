import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeMessageRoles } from '../../src/main/proxy/utils/messageRoles.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

// 客户端实际发来的 `developer` 消息（类型里没有它，运行时却有）
const asIncoming = (message: Record<string, unknown>): ChatMessage => message as unknown as ChatMessage

test('developer 折成 system，其余消息逐字段保持原样', () => {
  const toolCall = { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }
  const messages = [
    asIncoming({ role: 'developer', content: 'be terse' }),
    asIncoming({ role: 'user', content: [{ type: 'text', text: 'hi' }] }),
    asIncoming({ role: 'assistant', content: null, tool_calls: [toolCall] }),
    asIncoming({ role: 'developer', content: 'no markdown', name: 'policy' }),
  ]

  const normalized = normalizeMessageRoles(messages)

  assert.deepEqual(normalized.map((message) => message.role), ['system', 'user', 'assistant', 'system'])
  assert.deepEqual(normalized[1], messages[1], '非 developer 消息必须原样保留')
  assert.deepEqual(normalized[2], messages[2], 'tool_calls 等字段不得被改写')
  assert.deepEqual(normalized[3], { role: 'system', content: 'no markdown', name: 'policy' }, '内容与 name 随角色一起保留')
})

test('入参不被修改，折过的消息是新对象', () => {
  const messages = [asIncoming({ role: 'developer', content: 'be terse' }), asIncoming({ role: 'user', content: 'hi' })]
  const snapshot = JSON.parse(JSON.stringify(messages))

  const normalized = normalizeMessageRoles(messages)

  assert.deepEqual(JSON.parse(JSON.stringify(messages)), snapshot, '原数组必须保持 developer')
  assert.notEqual(normalized[0], messages[0], '折过的消息是新对象')
})

test('没有 developer 时结果与原消息等价', () => {
  const messages = [asIncoming({ role: 'system', content: 's' }), asIncoming({ role: 'user', content: 'u' })]
  assert.deepEqual(normalizeMessageRoles(messages), messages)
})
