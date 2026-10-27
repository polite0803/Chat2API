import test from 'node:test'
import assert from 'node:assert/strict'
import { renderTranscript } from '../../src/main/proxy/utils/transcript.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

test('transcript keeps every user and assistant turn in order', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys prompt' },
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: [{ type: 'text', text: 'second question' } as any] },
  ]

  const transcript = renderTranscript(messages, 'qwen-ai')

  assert.doesNotMatch(transcript, /sys prompt/)
  assert.match(transcript, /User: first question/)
  assert.match(transcript, /Assistant: first answer/)
  assert.match(transcript, /User: second question/)
  assert.ok(transcript.indexOf('first answer') < transcript.indexOf('second question'))
})

test('transcript keeps tool calls and their results correlated', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'weather?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_r-0', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hangzhou"}' } } as any,
      ],
    },
    { role: 'tool', tool_call_id: 'call_r-0', content: [{ type: 'text', text: 'sunny' } as any] },
    { role: 'assistant', content: 'It is sunny.' },
  ]

  const transcript = renderTranscript(messages, 'qwen-ai')

  assert.match(transcript, /tool_call_id="call_r-0"/)
  assert.match(transcript, /get_weather/)
  assert.match(transcript, /sunny/)
  assert.match(transcript, /Assistant: It is sunny\./)
  assert.doesNotMatch(transcript, /object Object/)
})
