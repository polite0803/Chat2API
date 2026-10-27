import test from 'node:test'
import assert from 'node:assert/strict'
import { getProviderToolProfile } from '../../src/main/proxy/toolCalling/providerProfiles.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { ToolCallingEngine } from '../../src/main/proxy/toolCalling/ToolCallingEngine.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

const baseChunk = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm' }

function plan(overrides: Partial<ToolCallingPlan> = {}): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'deepseek',
    tools: [{ name: 'read_file', parameters: { type: 'object' }, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['read_file']),
    parallelToolCalls: true,
    diagnostics: {
      clientAdapterId: 'standard-openai-tools',
      providerId: 'deepseek',
      model: 'm',
      actualModel: 'm',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
    ...overrides,
  }
}

const twoCalls =
  '<|CHAT2API|tool_calls>' +
  '<|CHAT2API|invoke name="read_file" tool_call_id="call_a"><|CHAT2API|parameter name="path">/a</|CHAT2API|parameter></|CHAT2API|invoke>' +
  '<|CHAT2API|invoke name="read_file" tool_call_id="call_b"><|CHAT2API|parameter name="path">/b</|CHAT2API|parameter></|CHAT2API|invoke>' +
  '</|CHAT2API|tool_calls>'

test('replayed assistant calls keep their tool_call_id', () => {
  const profile = getProviderToolProfile('deepseek')
  const rendered = profile.formatAssistantToolCalls([
    { id: 'call_r-0', name: 'read_file', arguments: '{"path":"/a"}' },
  ])

  assert.match(rendered, /tool_call_id="call_r-0"/)
  assert.match(rendered, /parameter name="path"/)
  assert.match(profile.formatToolResult({ toolCallId: 'call_r-0', content: 'ok' }), /tool_call_id="call_r-0"/)
})

test('unparseable historical arguments are preserved verbatim', () => {
  const profile = getProviderToolProfile('deepseek')
  const rendered = profile.formatAssistantToolCalls([
    { id: 'call_r-1', name: 'read_file', arguments: 'not-json-payload' },
  ])

  assert.match(rendered, /not-json-payload/)
  assert.match(rendered, /tool_call_id="call_r-1"/)
})

test('parallel_tool_calls:false keeps only the first streamed call', () => {
  const parser = new ToolStreamParser(plan({ parallelToolCalls: false }))
  const chunks = parser.push(twoCalls, baseChunk)
  const calls = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)

  assert.equal(calls.length, 1)
})

test('parallel calls are all emitted when parallel_tool_calls is not disabled', () => {
  const parser = new ToolStreamParser(plan())
  const chunks = parser.push(twoCalls, baseChunk)
  const calls = chunks.filter((chunk) => chunk.choices[0].delta.tool_calls)

  assert.equal(calls.length, 2)
  assert.notEqual(
    calls[0].choices[0].delta.tool_calls[0].id,
    calls[1].choices[0].delta.tool_calls[0].id
  )
})

test('required tool choice injects a directive and non-stream keeps a single call', () => {
  const engine = new ToolCallingEngine({ enabled: true, mode: 'auto' })
  const transformed = engine.transformRequest({
    request: {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
    } as any,
    provider: { id: 'deepseek' } as any,
    actualModel: 'm',
    requestId: 'chatcmpl-r',
  })

  assert.match(String(transformed.messages[0].content), /must call at least one/i)
  assert.match(String(transformed.messages[0].content), /at most one tool/i)

  const result: any = {
    choices: [{ index: 0, message: { role: 'assistant', content: twoCalls }, finish_reason: 'stop' }],
  }
  engine.applyNonStreamResponse(result, transformed.plan)

  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.tool_calls.length, 1)
  assert.equal(result.choices[0].message.tool_calls[0].id, 'call_chatcmpl-r-0')
})

test('forced tool choice names the tool in the directive', () => {
  const engine = new ToolCallingEngine({ enabled: true, mode: 'auto' })
  const transformed = engine.transformRequest({
    request: {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } },
      ],
      tool_choice: { type: 'function', function: { name: 'write_file' } },
    } as any,
    provider: { id: 'deepseek' } as any,
    actualModel: 'm',
  })

  assert.match(String(transformed.messages[0].content), /must call the tool "write_file"/i)
})
