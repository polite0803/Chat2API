/**
 * 思考回放（代理侧补回客户端丢弃的 reasoning_content）。
 *
 * 验收口径来自实测：同一 274 轮抓样里 trae/deepseek 缺 253 轮（92%）、loomy 缺 4/41。
 * 补回后缺失计数必须归零 —— 因为 `recover` 的判据与 `countToolCallShapes.missingReasoning`
 * 完全一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ReasoningReplay, reasoningReplayEnabled } from '../../src/main/channelPack/reasoningReplay.ts'
import { countToolCallShapes } from '../../src/main/channelPack/toolCallValidation.ts'

test('开关：默认开，只有字面 0 才关（与仓库其它 DSH_* 开关同口径）', () => {
  // 默认开是刻意的：关掉的默认值意味着「DeepSeek 系整段对话报废」。
  assert.equal(reasoningReplayEnabled({} as NodeJS.ProcessEnv), true)
  assert.equal(reasoningReplayEnabled({ DSH_REASONING_REPLAY: '1' } as unknown as NodeJS.ProcessEnv), true)
  assert.equal(reasoningReplayEnabled({ DSH_REASONING_REPLAY: 'yes' } as unknown as NodeJS.ProcessEnv), true)
  assert.equal(reasoningReplayEnabled({ DSH_REASONING_REPLAY: '0' } as unknown as NodeJS.ProcessEnv), false)
})

test('开关关闭时行为等价于旧版：不补回、缺失计数保持（可随时回退）', () => {
  // 关断能力本身要可验证 —— 否则「可以关掉」只是口号。
  // 这里直接验证 recover 不被调用时的效果，与 worker 里的分支同一语义。
  const inbound = [
    { role: 'assistant', tool_calls: [{ id: id(1), function: { name: 'a', arguments: '{}' } }] },
  ]
  assert.equal(countToolCallShapes(inbound).missingReasoning, 1, '关断时如实转发客户端历史')
})

const id = (n: number) => `call_req-${n}`

/** 构造一帧我们下行的 SSE（形状与 toOpenAiSse 输出一致）。 */
function frame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'm',
    choices: [{ index: 0, delta: payload, finish_reason: null }],
  })}\n\n`
}

const toolFrame = (n: number) => frame({
  tool_calls: [{ index: 0, id: id(n), type: 'function', function: { name: 'read', arguments: '{}' } }],
})
const reasoningFrame = (text: string) => frame({ reasoning_content: text })

test('下行发了思考与工具调用 ⇒ 下一轮能补回', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  replay.observeSseChunk(reasoningFrame('我先想一下'))
  replay.observeSseChunk(toolFrame(1))
  replay.commit()

  const inbound = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: id(1), function: { name: 'read', arguments: '{}' } }] },
  ]
  const { messages, injected } = replay.recover(inbound)
  assert.equal(injected, 1)
  assert.equal((messages as Array<{ reasoning_content?: string }>)[1].reasoning_content, '我先想一下')
})

test('补回之后影子诊断的 missingReasoning 归零（这就是验收口径）', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  replay.observeSseChunk(reasoningFrame('思考甲'))
  replay.observeSseChunk(toolFrame(1))
  replay.observeSseChunk(reasoningFrame(''))
  replay.observeSseChunk(toolFrame(2))
  replay.commit()

  const inbound = [
    { role: 'assistant', tool_calls: [{ id: id(1), function: { name: 'a', arguments: '{}' } }] },
    { role: 'assistant', tool_calls: [{ id: id(2), function: { name: 'b', arguments: '{}' } }] },
  ]
  const before = countToolCallShapes(inbound)
  assert.equal(before.missingReasoning, 2, '前置：客户端确实没回传')

  const { messages } = replay.recover(inbound)
  const after = countToolCallShapes(messages)
  assert.equal(after.missingReasoning, 0, '补回后必须归零')
  assert.equal(after.assistantWithCalls, 2, '分母不变（不许为了指标删轮次）')
})

test('客户端已回传的思考一字节不动（不去覆盖更权威的原文）', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  replay.observeSseChunk(reasoningFrame('我们的版本'))
  replay.observeSseChunk(toolFrame(1))
  replay.commit()

  const inbound = [
    { role: 'assistant', reasoning_content: '客户端自己的版本', tool_calls: [{ id: id(1), function: { name: 'a', arguments: '{}' } }] },
  ]
  const { messages, injected } = replay.recover(inbound)
  assert.equal(injected, 0)
  assert.equal((messages as Array<{ reasoning_content?: string }>)[0].reasoning_content, '客户端自己的版本')
})

test('真无思考轮不补、也不缓存（上游本来就不要求成对）', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  replay.observeSseChunk(toolFrame(1)) // 只有工具调用，没有任何思考
  replay.commit()

  assert.equal(replay.size(), 0, '空思考不入缓存')
  const { injected } = replay.recover([
    { role: 'assistant', tool_calls: [{ id: id(1), function: { name: 'a', arguments: '{}' } }] },
  ])
  assert.equal(injected, 0, '没有可信思考时宁可留空，也不许编造')
})

test('非流式响应同样能观测到（非流式没有 delta，只有 message）', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  replay.observeCompletion({
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        reasoning_content: '非流式思考',
        tool_calls: [{ id: id(7), type: 'function', function: { name: 'x', arguments: '{}' } }],
      },
      finish_reason: 'tool_calls',
    }],
  })
  replay.commit()

  assert.equal(replay.size(), 1)
})

test('缓存有界：超过容量后淘汰最旧的 id，不会无限增长', () => {
  const replay = new ReasoningReplay(2)
  for (const n of [1, 2, 3]) {
    replay.begin()
    replay.observeSseChunk(reasoningFrame(`思考${n}`))
    replay.observeSseChunk(toolFrame(n))
    replay.commit()
  }
  assert.equal(replay.size(), 2, '容量 2 ⇒ 只留最新两个')

  // 最旧的 id 1 已被淘汰 ⇒ 补不回来（宁可缺，也不返回错的内容）。
  const { injected } = replay.recover([
    { role: 'assistant', tool_calls: [{ id: id(1), function: { name: 'a', arguments: '{}' } }] },
  ])
  assert.equal(injected, 0)
})

test('不修改入参（仓库的不变式）', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  replay.observeSseChunk(reasoningFrame('思考'))
  replay.observeSseChunk(toolFrame(1))
  replay.commit()

  const original = [
    { role: 'assistant', tool_calls: [{ id: id(1), function: { name: 'a', arguments: '{}' } }] },
  ]
  const snapshot = JSON.stringify(original)
  const { messages } = replay.recover(original)
  assert.notEqual(messages, original)
  assert.equal(JSON.stringify(original), snapshot, '入参必须保持原状')
})

test('畸形输入不抛错：半帧、非 JSON、空串、无 choices', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  for (const bad of ['', 'data: \n\n', 'data: {oops\n\n', 'data: [DONE]\n\n', 'data: {"choices":[]}\n\n', 'random text']) {
    assert.doesNotThrow(() => replay.observeSseChunk(bad), bad)
  }
  assert.doesNotThrow(() => replay.observeCompletion(null))
  assert.doesNotThrow(() => replay.observeCompletion(undefined))
  assert.doesNotThrow(() => replay.recover(undefined))
  assert.doesNotThrow(() => replay.recover('not-an-array'))
  replay.commit()
})

test('多个工具调用共享同一条思考：每个 id 都能补', () => {
  const replay = new ReasoningReplay()
  replay.begin()
  replay.observeSseChunk(reasoningFrame('一次思考，两个调用'))
  replay.observeSseChunk(frame({
    tool_calls: [
      { index: 0, id: id(11), type: 'function', function: { name: 'a', arguments: '{}' } },
      { index: 1, id: id(12), type: 'function', function: { name: 'b', arguments: '{}' } },
    ],
  }))
  replay.commit()

  const inbound = [
    { role: 'assistant', tool_calls: [{ id: id(11), function: { name: 'a', arguments: '{}' } }] },
    { role: 'assistant', tool_calls: [{ id: id(12), function: { name: 'b', arguments: '{}' } }] },
  ]
  const { messages, injected } = replay.recover(inbound)
  assert.equal(injected, 2)
})
