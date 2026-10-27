import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'stream'
import { createToolViolationTap } from '../../src/main/proxy/utils/toolViolationTap.ts'

function sse(chunk: object): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

async function collect(input: Readable): Promise<string> {
  const output = createToolViolationTap()
  input.pipe(output)
  let text = ''
  for await (const chunk of output as AsyncIterable<Buffer>) {
    text += chunk.toString()
  }
  return text
}

test('a required tool call that never happened is annotated on the finish chunk', async () => {
  const output = await collect(
    Readable.from([
      sse({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'plain answer' }, finish_reason: null }] }),
      sse({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ])
  )

  const finishLine = output
    .split('\n\n')
    .map((event) => event.replace(/^data: /, ''))
    .filter((payload) => payload && payload !== '[DONE]')
    .map((payload) => JSON.parse(payload))
    .find((chunk) => chunk.choices?.[0]?.finish_reason)

  assert.equal(finishLine?.choices[0].finish_reason, 'stop')
  assert.equal(finishLine?.x_chat2api_tool_violation, 'required')
  assert.equal((output.match(/\[DONE\]/g) || []).length, 1)
})

test('streams that did call a tool are left untouched', async () => {
  const output = await collect(
    Readable.from([
      sse({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_x-0', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: null }] }),
      sse({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      'data: [DONE]\n\n',
    ])
  )

  assert.doesNotMatch(output, /x_chat2api_tool_violation/)
  assert.match(output, /"finish_reason":"tool_calls"/)
})

test('non-JSON events pass through unchanged', async () => {
  const output = await collect(Readable.from([': keepalive\n\n', 'data: not-json\n\n', 'data: [DONE]\n\n']))

  assert.match(output, /: keepalive/)
  assert.match(output, /data: not-json/)
  assert.equal((output.match(/\[DONE\]/g) || []).length, 1)
})
