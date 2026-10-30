import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'stream'
import { wrapStreamWithPlan } from '../../src/main/proxy/toolCalling/streamPlanWrapper.ts'
import type { ToolCallingPlan } from '../../src/main/proxy/toolCalling/types.ts'

function sse(chunk: object): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function plan(): ToolCallingPlan {
  return {
    mode: 'managed',
    protocol: 'managed_xml',
    clientAdapterId: 'standard-openai-tools',
    providerId: 'zai',
    tools: [{ name: 'read_file', parameters: { type: 'object' }, source: 'openai' }],
    shouldInjectPrompt: true,
    shouldParseResponse: true,
    toolChoiceMode: 'auto',
    allowedToolNames: new Set(['read_file']),
    diagnostics: {
      requestId: 'chatcmpl-x',
      clientAdapterId: 'standard-openai-tools',
      providerId: 'zai',
      model: 'glm',
      actualModel: 'glm',
      toolSource: 'openai',
      mode: 'managed',
      protocol: 'managed_xml',
      toolCount: 1,
      injected: true,
      reason: 'test',
    },
  }
}

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  const parts: string[] = []
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    parts.push(chunk.toString())
  }
  return parts.join('')
}

test('managed tool markup from a plan-less provider becomes tool_calls', async () => {
  const toolBlock =
    '<|MODELPORT|tool_calls><|MODELPORT|invoke name="read_file"><|MODELPORT|parameter name="path">/tmp/a</|MODELPORT|parameter></|MODELPORT|invoke></|MODELPORT|tool_calls>'

  const input = Readable.from([
    sse({ id: 'c1', model: 'glm', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
    sse({ id: 'c1', model: 'glm', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { content: `hello ${toolBlock}` }, finish_reason: null }] }),
    sse({ id: 'c1', model: 'glm', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ])

  const output = await collect(wrapStreamWithPlan(input, plan()))

  assert.match(output, /"tool_calls"/)
  assert.match(output, /"id":"call_chatcmpl-x-0"/)
  assert.match(output, /"finish_reason":"tool_calls"/)
  assert.doesNotMatch(output, /modelport\|tool_calls/)
  assert.equal((output.match(/\[DONE\]/g) || []).length, 1)
})

test('plain text streams pass through untouched with a single done sentinel', async () => {
  const input = Readable.from([
    sse({ id: 'c2', model: 'glm', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: { content: 'plain answer' }, finish_reason: null }] }),
    sse({ id: 'c2', model: 'glm', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    'data: [DONE]\n\n',
  ])

  const output = await collect(wrapStreamWithPlan(input, plan()))

  assert.match(output, /plain answer/)
  assert.doesNotMatch(output, /tool_calls/)
  assert.match(output, /"finish_reason":"stop"/)
  assert.equal((output.match(/\[DONE\]/g) || []).length, 1)
})
