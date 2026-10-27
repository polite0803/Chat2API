import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readModelList } from '../../src/main/providers/modelListReaders.ts'
import {
  buildAuthHeaders,
  buildRequestBody,
  buildRequestUrl,
} from '../../src/main/providers/modelListRequest.ts'

// The fixtures below are captured payloads, not invented ones:
//   qwen-ai  GET  https://chat.qwen.ai/api/models
//   kimi     POST https://www.kimi.com/apiv2/kimi.gateway.config.v1.ConfigService/GetAvailableModels
//   qwen cn  GET  https://chat2-api.qianwen.com/api/v1/model/list
//   zai      GET  https://chat.z.ai/api/models (session required)

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

test('auto unwraps the double data envelope chat.qwen.ai wraps in', () => {
  const result = readModelList({
    data: {
      data: [
        { id: 'qwen3.7-max', name: 'Qwen3.7-Max', object: 'model' },
        { id: 'qwen3.8-omni-flash', name: 'Qwen3.8-Omni-Flash', object: 'model' },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.models.length, 2)
  assert.deepEqual(result.models[0], {
    displayName: 'Qwen3.7-Max',
    actualModelId: 'qwen3.7-max',
  })
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

test('auto reads kimi gateway availableModels as captured and dedupes by id', () => {
  const result = readModelList({
    availableModels: [
      { scenario: 'SCENARIO_OK_COMPUTER', displayName: 'K3', key: 'k3', id: 'k3-agent' },
      { scenario: 'SCENARIO_OK_COMPUTER', displayName: 'K2.8', key: 'k28-preview', id: 'k28-agent-preview' },
      { scenario: 'SCENARIO_CHAT', displayName: 'Instant', key: 'k2d6', id: 'k2d6-chat' },
      { scenario: 'SCENARIO_AGENT', displayName: 'Instant', key: 'k2d6', id: 'k2d6-chat' },
    ],
    defaultScenario: 'SCENARIO_CHAT',
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'K3', actualModelId: 'k3-agent' },
    { displayName: 'K2.8', actualModelId: 'k28-agent-preview' },
    { displayName: 'Instant', actualModelId: 'k2d6-chat' },
  ])
})

test('auto reads the qwen-cn envelope and honours its show flag', () => {
  const result = readModelList({
    trace_id: 'abc',
    code: 0,
    msg: '',
    success: true,
    httpCode: 200,
    data: [
      { displayModelName: 'Qwen3.7-千问', modelCode: 'Qwen', show: true },
      { displayModelName: 'Qwen3.7-Max', modelCode: 'tongyi-qwen37-max-model', show: true },
      { displayModelName: 'Hidden One', modelCode: 'hidden-code', show: false },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'Qwen3.7-千问', actualModelId: 'Qwen' },
    { displayName: 'Qwen3.7-Max', actualModelId: 'tongyi-qwen37-max-model' },
  ])
})

test('auto reads the minimax-cloud config envelope as captured', () => {
  const result = readModelList({
    base_resp: { status_code: 0, status_msg: 'ok' },
    models: [
      {
        supported_variants: ['', 'thinking'],
        effort_options: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
        display_name: 'M3.1-Flash',
        provider_id: 'minimax',
        model_id: 'MiniMax-M3.1-Flash',
        context_limit: 512000,
      },
      {
        thinking_config: { default_value: 'true', mode: 'switchable' },
        provider_id: 'minimax',
        model_id: 'MiniMax-M3',
        display_name: 'M3',
        context_limit: 400000,
      },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'M3.1-Flash', actualModelId: 'MiniMax-M3.1-Flash' },
    { displayName: 'M3', actualModelId: 'MiniMax-M3' },
  ])
})

test('the minimax envelope is not swallowed by the generic list reader', () => {
  const result = readModelList(
    { base_resp: { status_code: 0 }, models: [{ model_id: 'MiniMax-M3', display_name: 'M3' }] },
    'openai-list'
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
})

test('mimo bot config keeps only the flagged entries, whose names do not collide', () => {
  const result = readModelList({
    code: 0,
    msg: '成功',
    data: {
      modelConfigList: [
        { name: 'MiMo-V2.6-Flash', model: 'mimo-v2.6-flash', isInPromptNameList: true },
        { name: 'MiMo-V2.6-Pro', model: 'mimo-v2.6-pro', isInPromptNameList: true },
        { name: 'MiMo-V2.6-Pro-UltraSpeed', model: 'mimo-v2.6-pro-ultraspeed-studio', isInPromptNameList: true },
        // unflagged internal entries, several sharing one name
        { name: 'mimo-omni', model: 'mimo-v2-omni' },
        { name: 'mimo-omni', model: 'mimo-v2.5' },
        { name: 'mimo-omni', model: 'clawm-alpha' },
        { name: 'mimo-v2.1-pro', model: 'mimo-v2.1-pro' },
        { name: 'mimo-v2.1-pro', model: 'mimo-v2.1-pro-preview' },
      ],
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(result.models, [
    { displayName: 'MiMo-V2.6-Flash', actualModelId: 'mimo-v2.6-flash' },
    { displayName: 'MiMo-V2.6-Pro', actualModelId: 'mimo-v2.6-pro' },
    { displayName: 'MiMo-V2.6-Pro-UltraSpeed', actualModelId: 'mimo-v2.6-pro-ultraspeed-studio' },
  ])
  const names = result.models.map(m => m.displayName)
  assert.equal(new Set(names).size, names.length)
})

test('a mimo payload with nothing flagged reports empty rather than a blank list', () => {
  const result = readModelList(
    { code: 0, data: { modelConfigList: [{ name: 'mimo-omni', model: 'mimo-v2-omni' }] } },
    'mimo-bot-config'
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'empty')
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
