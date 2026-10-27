import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'stream'
import {
  createTextCompletionChunkTransform,
  toTextCompletion,
} from '../../src/main/proxy/utils/textCompletion.ts'

test('non-stream completions use the text_completion shape', () => {
  const converted = toTextCompletion({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: null,
  })

  assert.equal(converted.object, 'text_completion')
  assert.equal(converted.choices[0].text, 'hi')
  assert.equal(converted.choices[0].message, undefined)
  assert.equal(converted.choices[0].logprobs, null)
  assert.equal(converted.usage, null)
})

test('streaming completions convert chat deltas into text deltas', async () => {
  const events = [
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'hel' }, finish_reason: null }] },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  const input = Readable.from([
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'data: [DONE]\n\n',
  ])

  const output = createTextCompletionChunkTransform()
  input.pipe(output)

  let text = ''
  for await (const chunk of output as AsyncIterable<Buffer>) {
    text += chunk.toString()
  }

  assert.match(text, /"object":"text_completion"/)
  assert.match(text, /"text":"hel"/)
  assert.match(text, /"text":"lo"/)
  assert.doesNotMatch(text, /"delta"/)
  assert.equal((text.match(/\[DONE\]/g) || []).length, 1)
})
