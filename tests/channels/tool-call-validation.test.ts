import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assertValidToolCalls,
  findToolCallViolation,
  countToolCallShapes,
  formatToolCallViolation,
} from '../../src/main/channelPack/toolCallValidation.ts'

/** 客户端回传的一条合法 assistant 工具调用。 */
const validCall = {
  id: 'call_abc',
  type: 'function',
  function: { name: 'get_stock_price', arguments: '{"code":"002837"}' },
}

test('合法的 tool_calls 不报错', () => {
  const messages = [
    { role: 'system', content: '你是选股助手' },
    { role: 'user', content: '查一下 002837' },
    { role: 'assistant', content: null, tool_calls: [validCall] },
  ]

  assert.equal(findToolCallViolation(messages), undefined)
})

test('arguments 是对象时报出坐标与实收类型', () => {
  const messages = [
    { role: 'user', content: '查一下' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: { code: '002837' } } }],
    },
  ]

  const violation = findToolCallViolation(messages)

  assert.equal(violation?.path, 'messages[1].tool_calls[0].function.arguments')
  assert.equal(violation?.expected, 'a string')
  assert.equal(violation?.received, 'object')
  assert.match(
    formatToolCallViolation(violation!),
    /assistant\.tool_calls contains an invalid function call: messages\[1\]\.tool_calls\[0\]\.function\.arguments must be a string, received object/,
  )
})

test('缺少 id 时点名到 id 字段', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: '{}' } }] },
  ]

  const violation = findToolCallViolation(messages)

  assert.equal(violation?.path, 'messages[0].tool_calls[0].id')
  assert.equal(violation?.expected, 'a non-empty string')
  assert.equal(violation?.received, 'undefined')
})

test('id 为空串按无效处理（与网关同口径）', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: '', function: { name: 'read', arguments: '{}' } }] },
  ]

  const violation = findToolCallViolation(messages)

  assert.equal(violation?.path, 'messages[0].tool_calls[0].id')
  assert.equal(violation?.received, 'empty string')
})

test('缺少 function.name 时点名到 function.name', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'call_1', function: { arguments: '{}' } }] },
  ]

  const violation = findToolCallViolation(messages)

  assert.equal(violation?.path, 'messages[0].tool_calls[0].function.name')
  assert.equal(violation?.received, 'undefined')
})

test('tool_calls 不是数组时报出类型', () => {
  const messages = [{ role: 'assistant', tool_calls: { name: 'read' } }]

  const violation = findToolCallViolation(messages)

  assert.equal(violation?.path, 'messages[0].tool_calls')
  assert.equal(violation?.expected, 'an array')
  assert.equal(violation?.received, 'object')
})

test('tool_calls 元素不是对象时报出类型', () => {
  const messages = [{ role: 'assistant', tool_calls: ['call_1'] }]

  const violation = findToolCallViolation(messages)

  assert.equal(violation?.path, 'messages[0].tool_calls[0]')
  assert.equal(violation?.expected, 'an object')
  assert.equal(violation?.received, 'string')
})

test('arguments 为空串是合法的（网关接受空串参数）', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: '' } }] },
  ]

  assert.equal(findToolCallViolation(messages), undefined)
})

test('非 assistant 角色的 tool_calls 不参与判定（网关也不读）', () => {
  const messages = [
    { role: 'user', content: 'hi', tool_calls: [{ id: '', function: {} }] },
    { role: 'tool', content: '42', tool_call_id: 'call_1' },
  ]

  assert.equal(findToolCallViolation(messages), undefined)
})

test('非数组的 messages 与缺字段的消息不报错（不是这一层的职责）', () => {
  assert.equal(findToolCallViolation(undefined), undefined)
  assert.equal(findToolCallViolation('not-an-array'), undefined)
  assert.equal(findToolCallViolation([null, 42, { role: 'assistant' }]), undefined)
})

test('报出的是第一条违规（顺序与网关一致：消息序、调用序）', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'ok', function: { name: 'a', arguments: '{}' } }] },
    { role: 'assistant', tool_calls: [
      { id: 'ok', function: { name: 'b', arguments: '{}' } },
      { id: 'ok', function: { name: 'c', arguments: 7 } },
    ] },
  ]

  const violation = findToolCallViolation(messages)

  assert.equal(violation?.path, 'messages[1].tool_calls[1].function.arguments')
})

test('assertValidToolCalls 对合法历史不抛错', () => {
  assert.doesNotThrow(() => assertValidToolCalls([
    { role: 'assistant', tool_calls: [validCall] },
  ]))
})

test('影子诊断：统计规范合法但上游可能不认的形状', () => {
  // 纯观测：它不进校验路径，只回答"缺 reasoning_content 占多少"这类问题。
  // 存在的理由见 countToolCallShapes 注释（请求体 1.8MB、日志只留开头 2%，
  // 从请求体取证结构性走不通）。
  const messages = [
    { role: 'system', content: 'x' },
    { role: 'assistant', content: 'no call here' },
    // 带 tool_calls 但缺 reasoning_content，且参数空串、名字带前缀
    { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'api:read', arguments: '' } }] },
    // 齐全：有 reasoning、有参数、裸名
    { role: 'assistant', reasoning_content: '想了', tool_calls: [{ id: 'b', function: { name: 'write', arguments: '{}' } }] },
  ]

  const counts = countToolCallShapes(messages)
  assert.equal(counts.assistantWithCalls, 2, '只数带 tool_calls 的 assistant 轮')
  assert.equal(counts.missingReasoning, 1)
  assert.equal(counts.emptyArguments, 1)
  assert.equal(counts.prefixedName, 1)
})

test('影子诊断：非法输入返回全 0，绝不抛错', () => {
  // 观测器不能在请求路径上制造新失败。
  for (const bad of [undefined, null, 'x', 42, {}]) {
    assert.deepEqual(countToolCallShapes(bad), {
      assistantWithCalls: 0, missingReasoning: 0, emptyArguments: 0, prefixedName: 0,
    })
  }
  assert.deepEqual(countToolCallShapes([null, 42, { role: 'user' }]), {
    assistantWithCalls: 0, missingReasoning: 0, emptyArguments: 0, prefixedName: 0,
  })
})

test('assertValidToolCalls 抛出的错误带 400（否则客户端收到 500 而非 invalid_request_error）', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'read', arguments: {} } }] },
  ]

  assert.throws(
    () => assertValidToolCalls(messages),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal((error as { status?: number }).status, 400)
      assert.match(
        error.message,
        /messages\[0\]\.tool_calls\[0\]\.function\.arguments must be a string, received object/,
      )
      return true
    },
  )
})
