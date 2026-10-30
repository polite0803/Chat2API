import test from 'node:test'
import assert from 'node:assert/strict'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const tools = [
  { name: 'default_api:read_file', parameters: { type: 'object' }, source: 'openai' as const },
]

function plan(protocol: ToolCallingPlan['protocol'] = 'managed_xml'): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol,
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools,
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['default_api:read_file']),
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      model: 'deepseek-chat',
      actualModel: 'deepseek-chat',
      toolSource: 'openai',
      mode: 'managed',
      protocol,
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

const baseChunk = {
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'deepseek-chat',
}

test('bracket marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  assert.deepEqual(parser.push('[fun', baseChunk), [])
  const chunks = parser.push('ction_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('bracket output is text when XML protocol is selected', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<tool_', baseChunk), [])
  const chunks = parser.push('calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('modelport XML marker split across chunks emits a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  assert.deepEqual(parser.push('<|MODELPORT|tool_', baseChunk), [])
  const chunks = parser.push('calls><|MODELPORT|invoke name="default_api:read_file"><|MODELPORT|parameter name="filePath">/tmp/a</|MODELPORT|parameter></|MODELPORT|invoke></|MODELPORT|tool_calls>', baseChunk)

  assert.equal(chunks.at(-1)?.choices[0].delta.tool_calls[0].function.name, 'default_api:read_file')
})

test('partial ModelPort start marker is reported as buffered so stream handlers do not leak it', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<|MODELPORT|tool_calls', baseChunk)

  assert.deepEqual(chunks, [])
  assert.equal(parser.isBuffering(), true)
})

test('text after a tool call is released instead of silently dropped', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('before <tool_calls><invoke name="default_api:read_file"><parameter name="filePath">/tmp/a</parameter></invoke></tool_calls> after', baseChunk)

  assert.equal(chunks[0].choices[0].delta.content, 'before ')
  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.content === ' after'), true)
})

test('invalid tool name is not emitted as a tool call', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push('<tool_calls><invoke name="missing"><parameter name="x">1</parameter></invoke></tool_calls>', baseChunk)

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
})

test('fenced code block examples are emitted as text and never as tool calls', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const text = '```xml\n<tool_calls><invoke name="default_api:read_file"><parameter name="filePath">fake</parameter></invoke></tool_calls>\n```'
  const chunks = parser.push(text, baseChunk)

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].choices[0].delta.content, text)
})

test('generated call IDs stay stable between emitted chunks and final state', () => {
  const parser = new ToolStreamParser(plan('managed_bracket'))
  const chunks = parser.push('[function_calls][call:default_api:read_file]{"filePath":"/tmp/a"}[/call][/function_calls]', baseChunk)
  const emittedId = chunks.at(-1)?.choices[0].delta.tool_calls[0].id

  assert.equal(parser.hasEmittedToolCall(), true)
  assert.match(String(emittedId), /^call-\d+$/)
  assert.deepEqual(parser.flush(baseChunk), [])
})

test('call ids are scoped to the request id and unique per response', () => {
  const planWithId = { ...plan('managed_xml'), diagnostics: { ...plan().diagnostics, requestId: 'chatcmpl-abc' } }
  const parser = new ToolStreamParser(planWithId)
  const block = '<|MODELPORT|tool_calls><|MODELPORT|invoke name="default_api:read_file"><|MODELPORT|parameter name="filePath">/tmp/a</|MODELPORT|parameter></|MODELPORT|invoke></|MODELPORT|tool_calls>'
  const first = parser.push(block, baseChunk)
  const second = parser.push(block, baseChunk)
  const ids = [
    first.at(-1)?.choices[0].delta.tool_calls[0].id,
    second.at(-1)?.choices[0].delta.tool_calls[0].id,
  ]

  assert.deepEqual(ids, ['call_chatcmpl-abc-0', 'call_chatcmpl-abc-1'])
})

test('a hallucinated tool name releases the surrounding text instead of swallowing it', () => {
  const parser = new ToolStreamParser(plan('managed_xml'))
  const chunks = parser.push(
    'answer <tool_calls><invoke name="missing"><parameter name="x">1</parameter></invoke></tool_calls> tail',
    baseChunk
  )

  assert.equal(chunks.some((chunk) => chunk.choices[0].delta.tool_calls), false)
  const text = chunks.map((chunk) => chunk.choices[0].delta.content || '').join('')
  assert.match(text, /answer/)
  assert.match(text, /tail/)
  assert.doesNotMatch(text, /<tool_calls>/)
})
