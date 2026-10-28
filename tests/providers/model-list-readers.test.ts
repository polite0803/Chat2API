import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readModelList } from '../../src/main/providers/modelListReaders.ts'
import {
  buildAuthHeaders,
  buildRequestBody,
  buildRequestUrl,
} from '../../src/main/providers/modelListRequest.ts'

// The remaining fixture is a captured OpenAI-style payload; the retired
// web-chat envelopes (qwen-ai double-data, kimi gateway, qwen-cn, minimax,
// mimo) were removed together with those providers' readers.

test('auto reads the flat OpenAI-style list', () => {
  const result = readModelList({
    object: 'list',
    data: [
      { id: 'deepseek-chat', object: 'model', owned_by: 'DeepSeek' },
      { id: 'kimi-k2', name: 'Kimi-K2.6', object: 'model' },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'deepseek-chat', actualModelId: 'deepseek-chat' },
    { displayName: 'Kimi-K2.6', actualModelId: 'kimi-k2' },
  ])
})

test('auto reads qwen-ai model list as captured', () => {
  const result = readModelList({
    data: [
      {
        id: 'qwen3.7-plus',
        name: 'Qwen3.7-Plus',
        object: 'model',
        owned_by: 'qwen',
        info: { id: 'qwen3.7-plus', user_id: '4a8cd1c0-a7f6-4cfa-b5dd-d6bdab408271' },
      },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'Qwen3.7-Plus', actualModelId: 'qwen3.7-plus' },
  ])
})

test('auto reads z.ai list, including a name that equals no code', () => {
  const result = readModelList({
    data: [
      { id: 'x-preview-l', name: 'GLM-5.3-Flash', object: 'model', created: 1787422019, owned_by: 'openai' },
      { id: 'glm-5.3', name: 'GLM-5.3', object: 'model' },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'GLM-5.3-Flash', actualModelId: 'x-preview-l' },
    { displayName: 'GLM-5.3', actualModelId: 'glm-5.3' },
  ])
})

test('an unrecognised payload is reported instead of an empty success', () => {
  for (const payload of [null, [], 'nope', 42, { models: [{ id: 'x' }] }]) {
    const result = readModelList(payload)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'unrecognized_shape')
  }
})

test('a named payload shape that carries no usable entry is empty, not unrecognized', () => {
  const result = readModelList({ data: [] }, 'openai-list')

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
})

test('asking for one reader does not silently borrow another shape', () => {
  const result = readModelList({ data: { data: [{ id: 'a', name: 'A' }] } }, 'openai-list')

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
})

test('entries without any id are skipped rather than turned into blank models', () => {
  const result = readModelList({
    data: [{ name: 'Ghost' }, { model: 'legacy-id' }, { id: 'real', name: 'Real' }],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'legacy-id', actualModelId: 'legacy-id' },
    { displayName: 'Real', actualModelId: 'real' },
  ])
})

test('blank and whitespace-only names fall back to the id', () => {
  const result = readModelList({ data: [{ id: 'only-id', name: '   ' }] })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [{ displayName: 'only-id', actualModelId: 'only-id' }])
})

test('openai-free-list keeps only the free slice of a mixed gateway catalogue', () => {
  const result = readModelList({
    data: [
      { id: 'kilo-auto/free', name: 'Kilo Auto Free', isFree: true },
      { id: 'paid/model', name: 'Paid Model', isFree: false },
      { id: 'paid/other', name: 'Other Paid' },
      { id: 'nvidia/nemotron:free', name: 'Nemotron (Free)', isFree: true },
    ],
  }, 'openai-free-list')

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'Kilo Auto Free', actualModelId: 'kilo-auto/free' },
    { displayName: 'Nemotron (Free)', actualModelId: 'nvidia/nemotron:free' },
  ])
})

test('a catalogue with no free model is an empty pool, not a success', () => {
  const result = readModelList({
    data: [
      { id: 'a', name: 'A', isFree: false },
      { id: 'b', name: 'B', isFree: false },
    ],
  }, 'openai-free-list')

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
})

test('qwen-cn envelope does not leak through the generic list reader', () => {
  const result = readModelList(
    { code: 0, success: true, data: [{ displayModelName: 'A', modelCode: 'a-code', show: true }] },
    'openai-list'
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
})

test('the {uuid} placeholder is replaced in the url and in string body values', () => {
  const url = buildRequestUrl('https://x.test/api/list?did={uuid}&k=v', '11111111-2222-3333-4444-555555555555')
  assert.equal(url, 'https://x.test/api/list?did=11111111-2222-3333-4444-555555555555&k=v')

  const body = buildRequestBody({ did: '{uuid}', limit: 20 }, 'aaaa')
  assert.deepEqual(body, { did: 'aaaa', limit: 20 })

  assert.deepEqual(buildRequestBody(undefined, 'aaaa'), {})
  assert.equal(buildRequestUrl('https://x.test/static', 'aaaa'), 'https://x.test/static')
})

test('no auth rules means the request goes out without credentials', () => {
  const result = buildAuthHeaders(undefined, { token: 'secret-value' })

  assert.equal(result.ok, true)
  assert.deepEqual(result.headers, {})
})

test('a header rule carries the prefix the provider expects', () => {
  const result = buildAuthHeaders(
    [{ from: 'token', into: 'header', header: 'Authorization', prefix: 'Bearer ' }],
    { token: 'jwt-value' }
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.headers, { Authorization: 'Bearer jwt-value' })
})

test('mimo style cookie rules build the cookie header the adapter builds', () => {
  const result = buildAuthHeaders(
    [
      { from: 'service_token', into: 'cookie', cookie: 'serviceToken' },
      { from: 'user_id', into: 'cookie', cookie: 'userId' },
      { from: 'ph_token', into: 'cookie', cookie: 'xiaomichatbot_ph' },
    ],
    { service_token: 's1', user_id: 'u1', ph_token: 'p1' }
  )

  assert.equal(result.ok, true)
  assert.deepEqual(result.headers, {
    Cookie: 'serviceToken=s1; userId=u1; xiaomichatbot_ph=p1',
  })
})

test('the first rule writing a cookie wins over a later one', () => {
  const result = buildAuthHeaders(
    [
      { from: 'sessionToken', into: 'cookie', cookie: 'sid' },
      { from: 'legacyToken', into: 'cookie', cookie: 'sid' },
    ],
    { sessionToken: 'first', legacyToken: 'second' }
  )

  assert.equal(result.ok, true)
  assert.equal(result.headers.Cookie, 'sid=first')
})

test('missing or blank fields are reported by name, never by value', () => {
  const result = buildAuthHeaders(
    [
      { from: 'service_token', into: 'cookie', cookie: 'serviceToken' },
      { from: 'ph_token', into: 'cookie', cookie: 'xiaomichatbot_ph' },
    ],
    { service_token: '  ', ph_token: undefined }
  )

  assert.equal(result.ok, false)
  assert.deepEqual(result.missingFields, ['service_token', 'ph_token'])
  assert.equal('headers' in result, false)
})

test('an absent credentials bag leaves every rule unresolved', () => {
  const result = buildAuthHeaders([{ from: 'token', into: 'header', header: 'Authorization' }], undefined)

  assert.equal(result.ok, false)
  assert.deepEqual(result.missingFields, ['token'])
})
