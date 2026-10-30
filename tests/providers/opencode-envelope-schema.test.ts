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
  // 真正要守住的约束：工具名是 const，参数 schema 内联。
  assert.deepEqual(
    items.anyOf.map((entry: any) => entry.properties.name.const),
    ['get_weather', 'Read'],
  )
  // 参数 schema 直接内联，而不是一个宽松的"任意对象"
  assert.deepEqual(items.anyOf[0].properties.arguments, tools[0].parameters)
})

test('信封只强制 calls：arguments 与 content 缺省不该让整回合失败', () => {
  const schema = buildEnvelopeSchema({ tools }) as any
  const items = schema.properties.calls.items

  // 模型给无参工具省略 arguments 是常态；把它放进 required 会触发
  // InvalidToolInputError，进而被运行时改写成 invalid 工具、整回合报废。
  for (const entry of items.anyOf) {
    assert.deepEqual(entry.required, ['name'])
  }
  assert.deepEqual(schema.required, ['calls'])
  assert.equal(schema.properties.content.type, 'string')
})

test('额外字段放行，但工具名的 const 仍然是硬约束', () => {
  const schema = buildEnvelopeSchema({ tools }) as any
  const items = schema.properties.calls.items

  // 放宽 additionalProperties 是为了容忍模型自带的解释字段，
  // 而不是为了让它可以编造工具名——`name` 仍然是 const。
  for (const entry of items.anyOf) {
    assert.equal(entry.additionalProperties, true)
    assert.equal(entry.properties.name.type, 'string')
    assert.ok(typeof entry.properties.name.const === 'string')
  }
  assert.equal(schema.additionalProperties, true)
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
