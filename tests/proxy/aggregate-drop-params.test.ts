import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyAggregateDropParams } from '../../src/main/proxy/aggregateParams.ts'

test('no rules leaves the body untouched (same reference)', () => {
  const body = { model: 'm', messages: [] }
  assert.equal(applyAggregateDropParams(body, undefined), body)
  assert.equal(applyAggregateDropParams(body, []), body)
})

test('a plain rule deletes the top-level field and keeps everything else', () => {
  const body = { model: 'm', messages: [], response_format: { type: 'json_object' }, temperature: 0 }
  const next = applyAggregateDropParams(body, ['response_format'])
  assert.deepEqual(next, { model: 'm', messages: [], temperature: 0 })
  assert.equal('response_format' in body, true, 'the input must not be mutated')
})

test('key=value only deletes on an exact match', () => {
  const auto = applyAggregateDropParams({ tool_choice: 'auto' }, ['tool_choice=auto'])
  assert.deepEqual(auto, {})

  const required = applyAggregateDropParams({ tool_choice: 'required' }, ['tool_choice=auto'])
  assert.deepEqual(required, { tool_choice: 'required' })
})

test('tools[].function.strict is stripped from every tool without touching the rest', () => {
  const body = {
    tools: [
      { type: 'function', function: { name: 'a', parameters: {}, strict: true } },
      { type: 'function', function: { name: 'b', parameters: {} } }
    ]
  }
  const next = applyAggregateDropParams(body, ['tools[].function.strict'])
  assert.deepEqual(next, {
    tools: [
      { type: 'function', function: { name: 'a', parameters: {} } },
      { type: 'function', function: { name: 'b', parameters: {} } }
    ]
  })
  assert.equal((body.tools[0].function as Record<string, unknown>).strict, true, 'input not mutated')
})

test('non-array tools and unknown rules are tolerated', () => {
  assert.deepEqual(applyAggregateDropParams({ tools: null }, ['tools[].function.strict']), { tools: null })
  assert.deepEqual(applyAggregateDropParams({ a: 1 }, ['b=2']), { a: 1 })
})
