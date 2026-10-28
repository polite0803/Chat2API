import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import {
  buildAnthropicRequest,
  convertAnthropicResponse,
  convertAnthropicStream,
} from '../../src/main/proxy/adapters/anthropic.ts'

const baseRequest = (overrides: Record<string, unknown> = {}) => ({
  model: 'anthropic/claude-sonnet',
  messages: [],
  ...overrides,
})

test('system turns are lifted into the system field, tool turns become tool_use/tool_result', () => {
  const request = baseRequest({
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'system', content: 'Use tools.' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"x"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'found' },
    ],
  })

  const body = buildAnthropicRequest(request as never, 'claude-sonnet-4')

  assert.equal(body.model, 'claude-sonnet-4')
  assert.equal(body.system, 'Be brief.\n\nUse tools.')
  assert.equal(body.messages.length, 3)
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
  })
  assert.deepEqual(body.messages[2], {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }],
  })
})

test('anthropic requires max_tokens, so a missing value gets the protocol default', () => {
  assert.equal(buildAnthropicRequest(baseRequest() as never, 'm').max_tokens, 4096)
  assert.equal(
    buildAnthropicRequest(baseRequest({ max_tokens: 123 }) as never, 'm').max_tokens,
    123,
  )
})

test('tool_choice is translated onto the anthropic vocabulary', () => {
  const tools = [{
    type: 'function',
    function: { name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } },
  }]

  const required = buildAnthropicRequest(
    baseRequest({ tools, tool_choice: 'required', parallel_tool_calls: false }) as never,
    'm',
  )
  assert.deepEqual(required.tool_choice, { type: 'any', disable_parallel_tool_use: true })
  assert.deepEqual(required.tools, [{
    name: 'lookup',
    description: 'd',
    input_schema: { type: 'object', properties: {} },
  }])

  const forced = buildAnthropicRequest(
    baseRequest({ tools, tool_choice: { type: 'function', function: { name: 'lookup' } } }) as never,
    'm',
  )
  assert.deepEqual(forced.tool_choice, { type: 'tool', name: 'lookup', disable_parallel_tool_use: false })

  // "none" cannot be expressed; tools are omitted instead.
  const none = buildAnthropicRequest(baseRequest({ tools, tool_choice: 'none' }) as never, 'm')
  assert.equal(none.tools, undefined)
})

test('a non-stream answer becomes an OpenAI completion', () => {
  const body = convertAnthropicResponse({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { q: 'x' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 7, output_tokens: 3 },
  }, 'anthropic/claude')

  const choice = (body as any).choices[0]
  assert.equal(choice.message.content, 'hello')
  assert.equal(choice.message.tool_calls[0].id, 'tool_1')
  assert.equal(choice.message.tool_calls[0].function.arguments, '{"q":"x"}')
  assert.equal(choice.finish_reason, 'tool_calls')
  assert.deepEqual((body as any).usage, {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10,
  })
})

test('usage stays absent when anthropic did not report it', () => {
  const body = convertAnthropicResponse({ content: [{ type: 'text', text: 'x' }] }, 'm')
  assert.equal((body as any).usage, undefined)
})

test('the SSE stream is re-emitted as OpenAI chunks with exactly one [DONE]', async () => {
  const source = new PassThrough()
  const output = convertAnthropicStream(source, 'anthropic/claude')

  const frames: string[] = []
  output.on('data', (chunk: Buffer) => frames.push(chunk.toString()))

  const done = new Promise<void>(resolve => output.on('end', resolve))

  source.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n')
  source.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
  source.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n')
  source.write('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool_1","name":"lookup"}}\n\n')
  source.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"x\\"}"}}\n\n')
  source.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n')
  source.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  source.end()
  await done

  const payloads = frames
    .join('')
    .split('\n\n')
    .filter(Boolean)
    .map(frame => frame.replace(/^data: /, ''))

  assert.equal(payloads.filter(payload => payload === '[DONE]').length, 1)
  const chunks = payloads
    .filter(payload => payload !== '[DONE]')
    .map(payload => JSON.parse(payload))

  assert.equal(chunks[0].choices[0].delta.role, 'assistant')
  assert.equal(chunks.some(c => c.choices[0].delta.content === 'Hi'), true)
  const toolFrame = chunks.find(c => c.choices[0].delta.tool_calls)
  assert.equal(toolFrame.choices[0].delta.tool_calls[0].id, 'tool_1')
  assert.equal(toolFrame.choices[0].delta.tool_calls[0].function.name, 'lookup')

  const final = chunks[chunks.length - 1]
  assert.equal(final.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(final.usage, { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 })
})
