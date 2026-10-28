import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEnvelopeSchema } from '../../src/main/opencode/envelopeSchema.ts'
import { normalizeTokens } from '../../src/main/opencode/bridge.ts'
import { toOpenAiUsage } from '../../src/main/proxy/adapters/opencode.ts'

const tools = [
  {
    name: 'get_weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  { name: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
]

test('Schema 把工具名写成 const、参数内联，模型编不出没提供的工具', () => {
  const schema = buildEnvelopeSchema({ tools }) as any
  const items = schema.properties.calls.items

  assert.equal(items.anyOf.length, 2)
  assert.ok(items.anyOf.every((entry: any) => entry.additionalProperties === false))
  assert.deepEqual(
    items.anyOf.map((entry: any) => entry.properties.name.const),
    ['get_weather', 'Read'],
  )
  // 参数 schema 直接内联，而不是一个宽松的"任意对象"
  assert.deepEqual(items.anyOf[0].properties.arguments, tools[0].parameters)
  assert.deepEqual(items.anyOf[0].required, ['name', 'arguments'])
  assert.deepEqual(schema.required, ['content', 'calls'])
})

test('没有参数的工具有兜底 schema', () => {
  const schema = buildEnvelopeSchema({ tools: [{ name: 'ping' }] }) as any
  assert.deepEqual(schema.properties.calls.items.anyOf[0].properties.arguments, {
    type: 'object',
    additionalProperties: true,
  })

  // 给了非 object 的 parameters 也一样兜底，不把非法 schema 递上去
  const weird = buildEnvelopeSchema({ tools: [{ name: 'x', parameters: { type: 'string' } }] }) as any
  assert.deepEqual(weird.properties.calls.items.anyOf[0].properties.arguments, {
    type: 'object',
    additionalProperties: true,
  })
})

test('tool_choice / parallel_tool_calls 落到 minItems / maxItems 上', () => {
  const base = buildEnvelopeSchema({ tools }) as any
  assert.equal(base.properties.calls.minItems, undefined)
  assert.equal(base.properties.calls.maxItems, undefined)

  const required = buildEnvelopeSchema({ tools, requireCall: true }) as any
  assert.equal(required.properties.calls.minItems, 1)

  const single = buildEnvelopeSchema({ tools, singleCall: true }) as any
  assert.equal(single.properties.calls.maxItems, 1)

  const both = buildEnvelopeSchema({ tools, requireCall: true, singleCall: true }) as any
  assert.equal(both.properties.calls.minItems, 1)
  assert.equal(both.properties.calls.maxItems, 1)
})

test('本轮不给工具时把 calls 封死', () => {
  const schema = buildEnvelopeSchema({ tools: [] }) as any
  assert.equal(schema.properties.calls.maxItems, 0)
  assert.equal(schema.properties.calls.items.type, 'object')
})

test('上游 token 形状被归一化，缺字段不编造', () => {
  assert.deepEqual(
    normalizeTokens({ input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } }),
    { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
  )
  assert.equal(normalizeTokens({}), null)
  assert.equal(normalizeTokens(null), null)
  assert.equal(normalizeTokens(undefined), null)
  // 只有部分字段也要如实保留，不能把缺的补成 0
  assert.deepEqual(normalizeTokens({ output: 7 }), {
    input: undefined,
    output: 7,
    reasoning: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  })
})

test('usage 按 OpenAI 口径合并 cache 与 reasoning', () => {
  assert.equal(toOpenAiUsage(null), null)
  assert.equal(toOpenAiUsage({ input: 0, output: 0 }), null)

  const usage = toOpenAiUsage({
    input: 100,
    output: 20,
    reasoning: 5,
    cacheRead: 30,
    cacheWrite: 10,
  })
  assert.deepEqual(usage, {
    prompt_tokens: 140,
    completion_tokens: 25,
    total_tokens: 165,
    prompt_tokens_details: { cached_tokens: 30 },
    completion_tokens_details: { reasoning_tokens: 5 },
  })
})
