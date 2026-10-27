import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { ProviderChecker } from '../../src/main/providers/checker.ts'
import { opencodeService } from '../../src/main/opencode/service.ts'
import { opencodeConfig } from '../../src/main/providers/builtin/opencode.ts'
import type { Provider } from '../../src/shared/types.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

const provider: Provider = {
  id: 'opencode',
  name: 'OpenCode',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: opencodeConfig.apiEndpoint,
  headers: {},
  enabled: true,
  createdAt: 1,
  updatedAt: 2,
}

test('状态检查不对本机运行时发 HTTP 请求', async () => {
  const result = await ProviderChecker.checkProviderStatus(provider)

  assert.equal(result.providerId, 'opencode')
  // 端点只是占位 scheme，发过去就是 axios 的 "Unsupported protocol opencode:"
  assert.doesNotMatch(result.error ?? '', /Unsupported protocol/i)
  assert.equal(result.status, 'unknown')
  // 原因必须是机器可读的码，界面自己翻成人话
  assert.ok(
    ['runtime_not_running', 'runtime_not_installed'].includes(result.reason ?? ''),
    `unexpected reason: ${result.reason}`,
  )
})

test('运行时已经在跑时报在线', async () => {
  const state = opencodeService.getState()
  const before = { running: state.running, lastError: state.lastError }
  state.running = true
  try {
    const result = await ProviderChecker.checkProviderStatus(provider)
    assert.equal(result.status, 'online')
    assert.equal(result.reason, 'runtime_running')
  } finally {
    state.running = before.running
    state.lastError = before.lastError
  }
})

test('运行时启动失败时报离线并带上原因', async () => {
  const state = opencodeService.getState()
  const before = { running: state.running, lastError: state.lastError }
  state.running = false
  state.lastError = 'spawn ENOENT'
  try {
    const result = await ProviderChecker.checkProviderStatus(provider)
    assert.equal(result.status, 'offline')
    assert.equal(result.reason, 'runtime_failed')
    assert.equal(result.error, 'spawn ENOENT')
  } finally {
    state.running = before.running
    state.lastError = before.lastError
  }
})

test('状态原因在两种语言里都有对应文案', () => {
  const reasons = ['runtime_running', 'runtime_not_running', 'runtime_not_installed', 'runtime_failed']
  for (const locale of ['zh-CN', 'en-US']) {
    const json = JSON.parse(
      readFileSync(join(root, `src/renderer/src/i18n/locales/${locale}.json`), 'utf8'),
    )
    for (const reason of reasons) {
      const message = json.providers?.statusReasons?.[reason]
      assert.equal(typeof message, 'string', `${locale} is missing statusReasons.${reason}`)
      assert.ok(message.length > 0)
    }
  }
})
