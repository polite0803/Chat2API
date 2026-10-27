import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { syncBuiltinProvider } from '../../src/main/store/providerSync.ts'
import kimiConfig from '../../src/main/providers/builtin/kimi.ts'
import glmConfig from '../../src/main/providers/builtin/glm.ts'
import type { Provider } from '../../src/main/store/types.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function stored(overrides: Partial<Provider>): Provider {
  return {
    id: 'kimi',
    name: 'Kimi',
    type: 'builtin',
    authType: 'jwt',
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
    const fixed = syncBuiltinProvider(stored({ type } as Partial<Provider>), kimiConfig)
    assert.equal(fixed.type, 'builtin')
    assert.equal(fixed.apiEndpoint, kimiConfig.apiEndpoint)
    assert.deepEqual(fixed.supportedModels, kimiConfig.supportedModels)
    assert.equal(fixed.supportsModelFetch, true, `kimi declares modelsFetch (type=${type})`)
  }
})

test('user-owned fields survive the repair', () => {
  const fixed = syncBuiltinProvider(stored({ name: 'My Kimi', enabled: false, createdAt: 7 }), kimiConfig)
  assert.equal(fixed.name, 'My Kimi')
  assert.equal(fixed.enabled, false)
  assert.equal(fixed.createdAt, 7)
})

test('a provider without modelsFetch is marked unsupported rather than inheriting a stale flag', () => {
  const fixed = syncBuiltinProvider(
    stored({ id: 'glm', supportedModels: ['GLM-9'], supportsModelFetch: true }),
    glmConfig,
  )
  assert.equal(fixed.supportsModelFetch, false)
  assert.deepEqual(fixed.supportedModels, glmConfig.supportedModels)
})

test('the flag tracks the shipped config on every startup', () => {
  assert.equal(Boolean(kimiConfig.modelsFetch), true)
  assert.equal(Boolean(glmConfig.modelsFetch), false)
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
