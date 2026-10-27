import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { findUnsupportedParameter } from '../../src/main/proxy/parameterPolicy.ts'
import { extractTextContent } from '../../src/main/proxy/utils/contentText.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'

const builtin = { type: 'builtin' }
const custom = { type: 'custom' }

function request(extra: Record<string, unknown> = {}): ChatCompletionRequest {
  return { model: 'm', messages: [{ role: 'user', content: 'hi' }], ...extra } as ChatCompletionRequest
}

test('shape-changing parameters are rejected for built-in providers', () => {
  assert.equal(findUnsupportedParameter(request({ response_format: { type: 'json_object' } }), builtin), 'response_format')
  assert.equal(findUnsupportedParameter(request({ stream_options: { include_usage: true } }), builtin), 'stream_options')
  assert.equal(findUnsupportedParameter(request({ seed: 7 }), builtin), 'seed')
  assert.equal(findUnsupportedParameter(request({ logit_bias: { '1': 1 } }), builtin), 'logit_bias')
  assert.equal(findUnsupportedParameter(request({ n: 2 }), builtin), 'n')
})

test('sampling knobs the adapters cannot honour are rejected instead of dropped', () => {
  assert.equal(findUnsupportedParameter(request({ top_p: 0.9 }), builtin), 'top_p')
  assert.equal(findUnsupportedParameter(request({ stop: ['x'] }), builtin), 'stop')
  assert.equal(findUnsupportedParameter(request({ frequency_penalty: 0.5 }), builtin), 'frequency_penalty')
  assert.equal(findUnsupportedParameter(request({ presence_penalty: 0.5 }), builtin), 'presence_penalty')
  assert.equal(findUnsupportedParameter(request({ max_tokens: 256 }), builtin), 'max_tokens')
})

test('text response_format and single choice stay accepted', () => {
  assert.equal(findUnsupportedParameter(request({ response_format: { type: 'text' } }), builtin), null)
  assert.equal(findUnsupportedParameter(request({ n: 1 }), builtin), null)
  assert.equal(findUnsupportedParameter(request(), builtin), null)
})

test('custom providers keep their existing pass-through behaviour', () => {
  assert.equal(findUnsupportedParameter(request({ response_format: { type: 'json_object' }, seed: 1 }), custom), null)
})

test('array tool content is flattened to text instead of [object Object]', () => {
  assert.equal(extractTextContent('plain'), 'plain')
  assert.equal(extractTextContent([{ type: 'text', text: 'ok' }]), 'ok')
  assert.equal(extractTextContent([{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'x' } }]), 'a')
  assert.equal(extractTextContent(null), '')
  assert.doesNotMatch(extractTextContent([{ type: 'text', text: 'ok' }]), /object Object/)
})

test('request correlation id is returned and context trimming keeps tool fields', () => {
  const chat = readFileSync(fileURLToPath(new URL('../../src/main/proxy/routes/chat.ts', import.meta.url)), 'utf8')
  const completions = readFileSync(fileURLToPath(new URL('../../src/main/proxy/routes/completions.ts', import.meta.url)), 'utf8')
  const forwarder = readFileSync(fileURLToPath(new URL('../../src/main/proxy/forwarder.ts', import.meta.url)), 'utf8')

  assert.match(chat, /ctx\.set\('X-Request-Id', requestId\)/)
  assert.match(completions, /ctx\.set\('X-Request-Id', requestId\)/)
  assert.match(forwarder, /messages: processResult\.messages\.map\(msg => \(\{ \.\.\.msg \}\)\)/)
  assert.match(forwarder, /\.\.\.msg,\s*\n\s*role: msg\.role/)
})

test('custom providers go through the same tool pipeline', () => {
  const forwarder = readFileSync(fileURLToPath(new URL('../../src/main/proxy/forwarder.ts', import.meta.url)), 'utf8')
  assert.match(forwarder, /buildRequestBody\(\{ \.\.\.request, messages: transformed\.messages \}/)
  assert.match(forwarder, /stream: wrapStreamWithPlan\(response\.data, transformed\.plan\)/)
  assert.match(forwarder, /this\.applyToolCallsToResponse\(response\.data, transformed\)/)
})
