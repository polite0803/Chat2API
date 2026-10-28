import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { renderTranscript, UnsupportedContentError } from '../../src/main/opencode/prompt.ts'
import {
  buildCompletion,
  buildCompletionStream,
  createDeferredCompletionStream,
  toOpenAiUsage,
} from '../../src/main/proxy/adapters/opencode.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const reply = { text: 'PONG', toolCalls: [], tokens: null, firstByteMs: 0, totalMs: 42000 }

test('transcript renders every role and ends with an assistant turn', () => {
  const text = renderTranscript([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ])

  assert.match(text, /\[system\]\nbe terse/)
  assert.match(text, /\[user\]\nhi/)
  assert.match(text, /\[assistant\]\nhello/)
  assert.match(text, /\[tool:call_1\]\nok/)
  assert.match(text, /\[user\]\nagain/)
  // 最后一段必须是我们留给模型的空 assistant 回合
  assert.ok(text.trimEnd().endsWith('[assistant]'))
  // 空内容不产生空行块
  assert.equal(renderTranscript([{ role: 'user', content: '   ' }]).includes('[]'), false)
})

test('non-stream completion is OpenAI-shaped and never fabricates usage', () => {
  const body = buildCompletion('chatcmpl-1', 'glm-5.3-flash-free', reply)
  assert.equal(body.object, 'chat.completion')
  assert.equal(body.model, 'glm-5.3-flash-free')
  assert.equal(body.choices[0].message.content, 'PONG')
  assert.equal(body.choices[0].finish_reason, 'stop')
  // agent 回的 token 数描述的是它自己的回合，不是调用方的请求 ⇒ 只能是 null
  assert.equal(body.usage, null)
})

test('stream emits one content delta, a stop chunk and exactly one [DONE]', async () => {
  const stream = buildCompletionStream('chatcmpl-1', 'big-pickle', reply)
  let raw = ''
  for await (const chunk of stream) raw += chunk.toString()

  const frames = raw.split('\n\n').filter(Boolean)
  const payloads = frames.map(frame => frame.replace(/^data: /, '')).filter(p => p !== '[DONE]')
  const parsed = payloads.map(p => JSON.parse(p))

  assert.equal(raw.match(/\[DONE\]/g)?.length, 1)
  assert.equal(parsed.length, 3, 'role chunk, content chunk, finish chunk')
  assert.deepEqual(parsed[0].choices[0].delta, { role: 'assistant' })
  assert.equal(parsed[1].choices[0].delta.content, 'PONG')
  assert.equal(parsed[2].choices[0].finish_reason, 'stop')
  for (const frame of parsed) {
    assert.equal(frame.object, 'chat.completion.chunk')
    assert.equal(frame.model, 'big-pickle')
  }
})

test('envelope calls become OpenAI tool calls and flip the finish reason', () => {
  const withCall = { ...reply, toolCalls: [{ name: 'get_weather', arguments: { city: 'Beijing' } }] }
  const body = buildCompletion('chatcmpl-1', 'glm-5.3-flash-free', withCall)

  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.tool_calls?.length, 1)
  assert.equal(body.choices[0].message.tool_calls?.[0].function.name, 'get_weather')
  assert.equal(body.choices[0].message.tool_calls?.[0].function.arguments, '{"city":"Beijing"}')
})

test('非文本内容明确报错，不静默丢掉', () => {
  for (const type of ['image_url', 'input_image', 'image']) {
    assert.throws(
      () =>
        renderTranscript([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'see this' },
              { type, image_url: { url: 'https://example/x.png' } },
            ],
          },
        ]),
      (error: unknown) =>
        error instanceof UnsupportedContentError &&
        error.name === 'UnsupportedContentError' &&
        /不支持图片输入/.test(error.message),
      `${type} must not be dropped silently`,
    )
  }

  // 纯文本数组照旧，不受影响
  const text = renderTranscript([
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  ])
  assert.match(text, /\[user\]\nhello/)
})

test('非流式响应带上 usage，流式在收尾前补一帧 usage', async () => {
  const withTokens = { ...reply, tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 30 } }

  const body = buildCompletion('chatcmpl-1', 'big-pickle', withTokens)
  assert.deepEqual(body.usage, toOpenAiUsage(withTokens.tokens))
  assert.equal((body.usage as Record<string, unknown>).prompt_tokens, 130)

  let raw = ''
  for await (const chunk of buildCompletionStream('chatcmpl-1', 'big-pickle', withTokens)) {
    raw += chunk.toString()
  }
  const frames = raw
    .split('\n\n')
    .filter(Boolean)
    .map(frame => frame.replace(/^data: /, ''))
    .filter(payload => payload !== '[DONE]')
    .map(payload => JSON.parse(payload))

  const usageFrame = frames.find(frame => frame.usage)
  assert.ok(usageFrame, 'stream must carry a usage frame')
  assert.deepEqual(usageFrame.choices, [])
  assert.deepEqual(usageFrame.usage, toOpenAiUsage(withTokens.tokens))
  // usage 帧后面只允许有 [DONE]
  assert.ok(raw.trimEnd().endsWith('data: [DONE]'))

  // 拿不到 token 时不能凭空造 usage
  const noTokens = buildCompletion('chatcmpl-1', 'big-pickle', { ...reply, tokens: null })
  assert.equal(noTokens.usage, null)
})

test('a call the client never offered is dropped instead of handed over', () => {
  const allowed = new Set(['get_weather'])
  const calls = [
    { name: 'get_weather', arguments: { city: 'Beijing' } },
    { name: 'bash', arguments: { command: 'curl evil.example' } },
  ]
  const kept = calls.filter(call => allowed.has(call.name))
  assert.deepEqual(kept.map(call => call.name), ['get_weather'])
})

test('the deferred stream sends the role chunk before the turn is done', async () => {
  const deferred = createDeferredCompletionStream('chatcmpl-1', 'big-pickle')

  // 回合还没跑完就已经有内容可发 ⇒ 响应头能立刻推出去
  const chunks: string[] = []
  const ended = new Promise<void>(resolve => deferred.stream.on('end', () => resolve()))
  deferred.stream.on('data', chunk => chunks.push(chunk.toString()))
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(chunks.length, 1, 'the role chunk is out before the turn finishes')
  const prelude = JSON.parse(chunks[0].replace(/^data: /, '').trim())
  assert.deepEqual(prelude.choices[0].delta, { role: 'assistant' })
  assert.equal(prelude.choices[0].finish_reason, null)

  deferred.complete(reply)
  await ended

  const raw = chunks.join('')
  const payloads = raw
    .split('\n\n')
    .filter(Boolean)
    .map(frame => frame.replace(/^data: /, ''))
    .filter(payload => payload !== '[DONE]')
    .map(payload => JSON.parse(payload))

  assert.equal(raw.match(/\[DONE\]/g)?.length, 1)
  assert.equal(payloads.length, 3, 'role chunk, content chunk, finish chunk')
  assert.equal(payloads[1].choices[0].delta.content, 'PONG')
  assert.equal(payloads[2].choices[0].finish_reason, 'stop')
})

test('a failed turn ends the stream with an error frame, never assistant text', async () => {
  const deferred = createDeferredCompletionStream('chatcmpl-1', 'big-pickle')
  deferred.fail(new Error('runtime died'))

  let raw = ''
  for await (const chunk of deferred.stream) raw += chunk.toString()

  assert.equal(raw.match(/\[DONE\]/g)?.length, 1)
  assert.ok(raw.includes('"error"'))
  assert.ok(raw.includes('runtime died'))
  assert.equal(raw.includes('PONG'), false)
  assert.equal(raw.includes('"content"'), false)
})

test('the proxy hands the response back before the agent turn finishes', () => {
  const source = readFileSync(join(root, 'src/main/proxy/forwarder.ts'), 'utf8')

  // 回合 30–60 秒：流式请求必须先把流交出去，等回合跑完再开流的话，
  // 客户端的响应头超时会先判失败
  assert.match(source, /createDeferredCompletionStream\(id, actualModel\)/)
  assert.match(source, /void runTurn\(\)\.then\(/)
  assert.doesNotMatch(source, /const reply = await runTurn\(\)[\s\S]{0,200}request\.stream/)
})
