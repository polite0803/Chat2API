import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { syncBuiltinProvider } from '../../src/main/store/providerSync.ts'
import opencodeConfig from '../../src/main/providers/builtin/opencode.ts'
import type { Provider } from '../../src/main/store/types.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function stored(overrides: Partial<Provider>): Provider {
  return {
    id: 'opencode',
    name: 'OpenCode',
    type: 'builtin',
    authType: 'userToken',
    apiEndpoint: 'https://stale.example',
    headers: {},
    enabled: true,
    createdAt: 1,
    updatedAt: 2,
    supportedModels: ['Old-Model'],
    modelMappings: { 'Old-Model': 'old-model' },
    ...overrides,
  }
}

test('a record with a stale or missing type is repaired and gets the shipped fields', () => {
  for (const type of ['custom', undefined] as const) {
    const fixed = syncBuiltinProvider(stored({ type } as Partial<Provider>), opencodeConfig)
    assert.equal(fixed.type, 'builtin')
    assert.equal(fixed.apiEndpoint, opencodeConfig.apiEndpoint)
    assert.deepEqual(fixed.supportedModels, opencodeConfig.supportedModels)
    assert.equal(fixed.supportsModelFetch, true, `opencode syncs through its local runtime (type=${type})`)
  }
})

test('user-owned fields survive the repair', () => {
  const fixed = syncBuiltinProvider(stored({ name: 'My OpenCode', enabled: false, createdAt: 7 }), opencodeConfig)
  assert.equal(fixed.name, 'My OpenCode')
  assert.equal(fixed.enabled, false)
  assert.equal(fixed.createdAt, 7)
})

test('a provider without modelsFetch is marked unsupported rather than inheriting a stale flag', () => {
  const fixed = syncBuiltinProvider(
    stored({ supportedModels: ['Stale'], supportsModelFetch: true }),
    { ...opencodeConfig, runtimeModels: undefined, modelsFetch: undefined },
  )
  assert.equal(fixed.supportsModelFetch, false)
  assert.deepEqual(fixed.supportedModels, opencodeConfig.supportedModels)
})

test('the flag tracks the shipped config on every startup', () => {
  assert.equal(Boolean(opencodeConfig.modelsFetch), false)
  assert.equal(Boolean(opencodeConfig.runtimeModels), true)
})

test('the local-account helper never demands a finished initialization', () => {
  const source = readFileSync(join(root, 'src/main/store/store.ts'), 'utf8')
  const start = source.indexOf('ensureLocalAccount(providerId: string): void {')
  assert.ok(start > 0, 'ensureLocalAccount must exist')
  const body = source.slice(start, source.indexOf('\n  }', start))

  // initializeDefaultProviders() calls it while isInitialized is still false:
  // ensureInitialized() there aborts the whole store startup
  assert.doesNotMatch(body, /ensureInitialized\(\)/)
  assert.match(body, /if \(!this\.store\) return/)
})
