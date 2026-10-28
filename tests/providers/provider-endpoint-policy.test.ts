import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  isRuntimeBackedProvider,
  validateApiEndpoint,
} from '../../src/main/providers/endpointPolicy.ts'
import { resolveModelListSource } from '../../src/main/providers/modelListSource.ts'
import { opencodeConfig } from '../../src/main/providers/builtin/opencode.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('只有内置的运行时供应商可以绕过 http/https 的 endpoint 规则', () => {
  assert.equal(isRuntimeBackedProvider('opencode', 'builtin'), true)
  // 自定义供应商自称 builtin 也不行：判定只看内置配置里的 runtimeModels
  assert.equal(isRuntimeBackedProvider('opencode', 'custom'), false)
  assert.equal(isRuntimeBackedProvider(undefined, 'builtin'), false)
  assert.equal(isRuntimeBackedProvider('made-up', 'builtin'), false)
})

test('endpoint 校验：HTTP 供应商照旧，本机运行时供应商接受占位 scheme', () => {
  const http = validateApiEndpoint('https://api.example.com/v1')
  assert.equal(http.valid, true)
  assert.deepEqual(http.errors, [])

  const rejected = validateApiEndpoint('opencode://local')
  assert.equal(rejected.valid, false)
  assert.ok(rejected.errors.includes('API endpoint must start with http:// or https://'))

  const runtime = validateApiEndpoint('opencode://local', true)
  assert.equal(runtime.valid, true)
  assert.deepEqual(runtime.errors, [])

  const empty = validateApiEndpoint('   ', true)
  assert.equal(empty.valid, false)
  assert.ok(empty.errors.includes('API endpoint cannot be empty'))

  const malformed = validateApiEndpoint('not a url', true)
  assert.equal(malformed.valid, false)
  assert.ok(malformed.errors.includes('Invalid API endpoint format'))

  const noScheme = validateApiEndpoint('opencode:/local', true)
  assert.equal(noScheme.valid, false)
  assert.ok(noScheme.errors.includes('Local runtime endpoint must look like <scheme>://<target>'))
})

test('添加供应商时把运行时豁免接进了 endpoint 校验', () => {
  const source = readFileSync(join(root, 'src/main/providers/custom.ts'), 'utf8')

  assert.match(source, /isRuntimeBackedProvider\(data\.id, data\.type\)/)
  assert.match(source, /validateApiEndpoint\(data\.apiEndpoint, this\.usesLocalRuntime\(data\)\)/)
  // 豁免只能来自内置配置，不能由调用方自报
  assert.doesNotMatch(source, /runtimeModels:\s*data\./)
})

test('模型清单来源：本机运行时优先于 HTTP 端点', () => {
  assert.equal(resolveModelListSource(opencodeConfig), 'runtime')
  assert.equal(
    resolveModelListSource({ ...opencodeConfig, runtimeModels: undefined, modelsFetch: { url: 'https://x.test/models', reader: 'auto' } }),
    'http',
  )
  assert.equal(resolveModelListSource({}), 'unsupported')
  assert.equal(resolveModelListSource(undefined), 'unsupported')
  // 运行时供应商本来就没有 modelsFetch，顺序反了会被判成"不支持在线更新"
  assert.equal(opencodeConfig.modelsFetch, undefined)
})

test('在线清单按来源判定，运行时分支不会被 modelsFetch 挡掉', () => {
  const source = readFileSync(join(root, 'src/main/providers/modelCatalog.ts'), 'utf8')

  assert.match(source, /resolveModelListSource\(config\)/)
  assert.match(source, /if \(source === 'runtime'\)/)
  assert.doesNotMatch(source, /if \(!config \|\| !fetchConfig\)/)
})
