import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readStreamOutcome } from '../../src/main/proxy/utils/streamOutcome.ts'

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
  frame({ object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] })

test('正常收尾：结束原因取自结束帧', () => {
  const text = chunk({ content: '你好' }) + chunk({}, 'length') + 'data: [DONE]\n\n'
  assert.deepEqual(readStreamOutcome(text), { finishReason: 'length', sawFinish: true })
})

test('结束帧之后还有帧：取最后一个结束原因', () => {
  const text = chunk({}, 'tool_calls') + chunk({ content: 'tail' }) + chunk({}, 'stop')
  assert.deepEqual(readStreamOutcome(text), { finishReason: 'stop', sawFinish: true })
})

test('只有 [DONE] 不算结束原因 —— 补发的 [DONE] 不代表上游宣布过结束', () => {
  assert.deepEqual(readStreamOutcome('data: [DONE]\n\n'), { finishReason: undefined, sawFinish: false })
})

test('上游发了错误帧（choices 为空）时本轮没有结束原因', () => {
  const text = chunk({ content: '半句话' }) +
    frame({ object: 'chat.completion.chunk', choices: [], error: { message: 'upstream stream ended before finish', code: 'incomplete_stream' } }) +
    'data: [DONE]\n\n'
  assert.deepEqual(readStreamOutcome(text), { finishReason: undefined, sawFinish: false })
})

test('被截断的半帧 JSON 不会让判定崩掉，也不算结束原因', () => {
  const text = chunk({ content: '正文' }) + 'data: {"choices":[{"finish_re'
  assert.deepEqual(readStreamOutcome(text), { finishReason: undefined, sawFinish: false })
})

test('空响应：没有帧就没有结束原因', () => {
  assert.deepEqual(readStreamOutcome(''), { finishReason: undefined, sawFinish: false })
})
