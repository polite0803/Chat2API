import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AGGREGATE_REGISTRY,
  getAggregateEntry,
  aggregateAuthHeader,
  aggregateChatPath,
  aggregateModelName,
} from '../../src/main/providers/aggregate/registry.ts'

test('the catalogue carries the entries that can actually be wired', () => {
  assert.equal(AGGREGATE_REGISTRY.length, 74)
  // 473 transcribed, minus 7 retired upstream on 2026-10-29 (3 anthropic + 4 xai),
  // minus the withdrawn mistral_codestral entry (its single model went with it),
  // plus the Agnes CN switch (agnes-2.0-flash -> agnes-3.0-flash + agnes-2.5-flash),
  // plus the Qiniu Conatus campaign entry (qiniu/conatus-free),
  // plus the SenseNova Token Plan entry (6 models).
  assert.equal(AGGREGATE_REGISTRY.reduce((sum, entry) => sum + entry.models.length, 0), 473)

  // Browser-login account channels are retired; the responses-only relay is not wired.
  for (const excluded of ['openai', 'github_copilot', 'fleetrelay_t1']) {
    assert.equal(getAggregateEntry(excluded), undefined, `${excluded} must not be listed`)
  }
  // ... but OpenAI's key endpoint stays, over the chat wire.
  const openai = getAggregateEntry('openai_api')
  assert.ok(openai)
  assert.equal(openai!.wire, 'openai-chat')
})

test('ids and model ids are unique so display names never collide', () => {
  const ids = new Set<string>()
  for (const entry of AGGREGATE_REGISTRY) {
    assert.equal(ids.has(entry.id), false, `duplicate entry id: ${entry.id}`)
    ids.add(entry.id)

    const modelIds = new Set<string>()
    for (const model of entry.models) {
      assert.equal(modelIds.has(model.id), false, `${entry.id} repeats model ${model.id}`)
      modelIds.add(model.id)
    }
  }

  const displayNames = new Set<string>()
  for (const entry of AGGREGATE_REGISTRY) {
    for (const model of entry.models) {
      const name = aggregateModelName(entry.id, model.id)
      assert.equal(displayNames.has(name), false, `duplicate display name: ${name}`)
      displayNames.add(name)
    }
  }
})

test('only the three anthropic endpoints use the messages wire', () => {
  const anthropic = AGGREGATE_REGISTRY
    .filter(entry => entry.wire === 'anthropic-messages')
    .map(entry => entry.id)
    .sort()
  assert.deepEqual(anthropic, ['anthropic', 'glm', 'minimax-cn'])

  for (const entry of AGGREGATE_REGISTRY) {
    assert.ok(entry.wire === 'openai-chat' || entry.wire === 'anthropic-messages')
  }
})

test('auth header follows the wire, with azure as the documented exception', () => {
  const anthropic = getAggregateEntry('anthropic')!
  assert.deepEqual(aggregateAuthHeader(anthropic), { header: 'x-api-key', prefix: '' })

  const glm = getAggregateEntry('glm')!
  assert.deepEqual(aggregateAuthHeader(glm), { header: 'x-api-key', prefix: '' })

  const azure = getAggregateEntry('azure_openai')!
  assert.deepEqual(aggregateAuthHeader(azure), { header: 'api-key', prefix: '' })

  const groq = getAggregateEntry('groq')!
  assert.deepEqual(aggregateAuthHeader(groq), { header: 'Authorization', prefix: 'Bearer ' })
})

test('chat path follows the wire', () => {
  assert.equal(aggregateChatPath(getAggregateEntry('anthropic')!), '/messages')
  assert.equal(aggregateChatPath(getAggregateEntry('groq')!), '/chat/completions')
})

test('kilo is key-less and every entry needing a key says where to get one', () => {
  const kilo = getAggregateEntry('kilo')!
  assert.equal(kilo.authKind, 'none')
  assert.equal(kilo.baseUrl, 'https://api.kilo.ai/api/gateway')
  assert.ok(kilo.models.some(model => model.id === 'kilo-auto/free'))

  for (const entry of AGGREGATE_REGISTRY) {
    if (entry.authKind !== 'apiKey') continue
    assert.ok(entry.authUrl, `${entry.id} must link to its key page`)
  }
})

test('entries without a usable default endpoint stay visible with a null baseUrl', () => {
  for (const id of ['azure_openai']) {
    const entry = getAggregateEntry(id)!
    assert.equal(entry.baseUrl, null)
  }
  // Placeholders are not expanded; the UI has to ask the user for a real baseUrl.
  for (const id of ['vertex', 'vertex-partner']) {
    assert.equal(getAggregateEntry(id)!.authKind, 'unsupported')
  }
})

/**
 * 上游已退役的模型不许被"重新转录"回来。它们仍会解析成 200（有的直接重定向到另一个模型），
 * 所以只有这份名单能挡住"看着能用、其实拿不到你要的模型"。
 */
test('models retired upstream stay out of the catalogue', () => {
  const retired: Array<[string, string]> = [
    ['anthropic', 'claude-sonnet-4-20250514'],
    ['anthropic', 'claude-opus-4-20250514'],
    ['anthropic', 'claude-3-5-sonnet-20241022'],
    ['xai', 'grok-4-fast-reasoning'],
    ['xai', 'grok-code-fast-1'],
    ['xai', 'grok-3'],
    ['xai', 'grok-4'],
  ]

  for (const [entryId, modelId] of retired) {
    const entry = getAggregateEntry(entryId)
    assert.ok(entry, `${entryId} must still be listed; only its dead models are removed`)
    assert.ok(
      !entry!.models.some(model => model.id === modelId),
      `${entryId}/${modelId} is retired upstream and must not be re-added`
    )
  }

  // 反向对照：删过头会把整家的活模型一起带走，这里钉住两家仍在服务的 id。
  for (const modelId of ['grok-4.6', 'grok-4.5']) {
    assert.ok(getAggregateEntry('xai')!.models.some(model => model.id === modelId), `xai/${modelId} still serves`)
  }
  assert.equal(getAggregateEntry('anthropic')!.models.length, 0, 'the anthropic entry is intentionally model-less')
})

test('the withdrawn codestral entry is gone, but its model stays reachable via mistral', () => {
  assert.equal(getAggregateEntry('mistral_codestral'), undefined,
    'codestral.mistral.ai is not in Mistral’s published docs; the entry was withdrawn on 2026-10-29')
  assert.ok(
    getAggregateEntry('mistral')!.models.some(model => model.id === 'codestral-latest'),
    'withdrawing the duplicate entry must not take codestral-latest away from the mistral entry'
  )
})
