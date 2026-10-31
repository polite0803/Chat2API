import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clientHeaderValue, identifyClientByUserAgent } from '../../src/shared/clientProfile.ts'

test('Trae 客户端按 UA 识别', () => {
  const identity = identifyClientByUserAgent('Trae/1.5.0 (Windows NT 10.0; Win64; x64)')
  assert.equal(identity.id, 'trae')
  assert.equal(identity.label, 'Trae')
  assert.equal(identity.version, '1.5.0')
  assert.equal(clientHeaderValue(identity), 'trae/1.5.0')
})

test('WorkBuddy 与 CodeBuddy 归为同一类', () => {
  assert.equal(identifyClientByUserAgent('WorkBuddy/2.1.3 (darwin)').id, 'workbuddy')
  assert.equal(identifyClientByUserAgent('CodeBuddy/1.0.0').id, 'workbuddy')
})

test('Qoder 中国版与国际版都归为 qoder', () => {
  assert.equal(identifyClientByUserAgent('Qoder/0.9.1 (Windows NT 10.0)').id, 'qoder')
  assert.equal(identifyClientByUserAgent('qoder-cn/0.9.1').id, 'qoder')
})

test('dsh 按词边界识别，不误伤 dashboard', () => {
  assert.equal(identifyClientByUserAgent('dsh/0.3.1').id, 'dsh')
  assert.equal(identifyClientByUserAgent('@deepseek-ai/dsh-llm 1.2.0').id, 'dsh')

  const dashboard = identifyClientByUserAgent('dashboard/1.0')
  assert.equal(dashboard.id, 'other')
  assert.equal(dashboard.label, 'dashboard')
})

test('OpenAI SDK 与 curl 可区分', () => {
  assert.equal(identifyClientByUserAgent('OpenAI/NodeJS/4.52.0').id, 'openai-node')
  assert.equal(identifyClientByUserAgent('OpenAI/Python 1.40.0').id, 'openai-python')
  assert.equal(identifyClientByUserAgent('curl/8.4.0').id, 'curl')
})

test('未知 UA 保留原始产品名而不是猜客户端', () => {
  const identity = identifyClientByUserAgent('python-requests/2.31.0')
  assert.equal(identity.id, 'other')
  assert.equal(identity.label, 'python-requests')
  assert.equal(identity.version, '2.31.0')
  assert.equal(clientHeaderValue(identity), 'other/2.31.0')
})

test('缺少 UA 不报错', () => {
  for (const missing of [undefined, null, '', '   ']) {
    const identity = identifyClientByUserAgent(missing)
    assert.equal(identity.id, 'other')
    assert.equal(identity.label, 'unknown')
    assert.equal(clientHeaderValue(identity), 'other')
  }
})

test('UA 头是数组时取第一个', () => {
  assert.equal(identifyClientByUserAgent(['Trae/1.0', 'Trae/1.1']).id, 'trae')
})
