/**
 * OpenCode 围栏的回归测试。
 *
 * 背景（实测 2026-10-30）：报错是
 *   `native_tool_activity: the model tried to use the OpenCode tool "invalid"`
 * 但模型**根本看不见** `invalid` 这个工具 —— 它是运行时的垃圾桶工具
 * （`ToolRegistry` 里存在，`activeTools` 里被摘掉）。模型一旦点了工具表里
 * 没有的名字、或参数过不了 schema，运行时的 `experimental_repairToolCall`
 * 就把那次调用改写成 `tool: "invalid"`，并把真相塞进 `state.input = {tool, error}`。
 *
 * 旧围栏只豁免 `StructuredOutput` 与 `status: 'error'`，于是把 `invalid`
 * 当成"模型动了原生工具"，报出自相矛盾的错误，并把一个成功后自纠的回合判死。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  INVALID_TOOL,
  ENVELOPE_TOOL,
  classifyInvalidTool,
  findNativeToolActivity,
  readInvalidToolActivity,
  type BridgePart,
} from '../../src/main/opencode/bridge.ts'

/** 运行时把「模型点错工具」改写成 invalid 时写进去的形状 */
const invalidPart = (tool: string, error: string): BridgePart => ({
  type: 'tool',
  tool: INVALID_TOOL,
  state: { status: 'completed', input: { tool, error } },
})

test('invalid 不是原生工具：模型看不见它，不能算"动了手"', () => {
  const parts: BridgePart[] = [invalidPart('get_weather', "Model tried to call unavailable tool 'get_weather'.")]

  // 关键回归：这曾经抛 native_tool_activity，而报错里的工具名是 "invalid"
  assert.equal(findNativeToolActivity(parts, { hasEnvelope: false }), null)
})

test('拿到信封就放行，哪怕回合中途点错过工具', () => {
  const parts: BridgePart[] = [
    // 第一轮点错（运行时改写成 invalid），第二轮自纠成功交出信封
    invalidPart('get_weather', "Model tried to call unavailable tool 'get_weather'."),
    { type: 'tool', tool: ENVELOPE_TOOL, state: { status: 'completed', input: { content: '', calls: [] } } },
  ]

  assert.equal(findNativeToolActivity(parts, { hasEnvelope: true }), null)
})

test('信封优先于原生工具痕迹：自纠成功的回合不该判失败', () => {
  // 极端情形：模型先真调了一次 read（被 permission deny 成 error），
  // 随后改口交出信封 —— 对客户端来说这一回合是有用的。
  const parts: BridgePart[] = [
    { type: 'tool', tool: 'read', state: { status: 'error', error: 'permission denied' } },
    { type: 'tool', tool: ENVELOPE_TOOL, state: { status: 'completed', input: { content: 'ok', calls: [] } } },
  ]

  assert.equal(findNativeToolActivity(parts, { hasEnvelope: true }), null)
})

test('真的执行了原生工具、又没交出信封，才判 native_tool_activity', () => {
  const parts: BridgePart[] = [
    { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } },
  ]

  assert.deepEqual(findNativeToolActivity(parts, { hasEnvelope: false }), { tool: 'bash' })
})

test('被围栏挡下的原生工具尝试（status=error）不算违规', () => {
  // permission 全 deny 后原生工具不会被真正执行，part 的状态就是 error。
  // 只罚"真的动了手"，被拦住的那次不算——与 Ferry 同口径。
  const parts: BridgePart[] = [
    { type: 'tool', tool: 'bash', state: { status: 'error', error: 'Permission denied' } },
  ]

  assert.equal(findNativeToolActivity(parts, { hasEnvelope: false }), null)
})

test('没有 tool 字段的 part 不会被误判', () => {
  const parts: BridgePart[] = [
    { type: 'text', text: 'hello' },
    { type: 'reasoning' },
    { type: 'tool', state: { status: 'completed' } },
  ]

  assert.equal(findNativeToolActivity(parts, { hasEnvelope: false }), null)
})

test('undefined parts 不抛错', () => {
  assert.equal(findNativeToolActivity(undefined, { hasEnvelope: false }), null)
})

test('readInvalidToolActivity 读出模型真正想调的名字与原因', () => {
  const activity = readInvalidToolActivity(
    invalidPart('get_weather', "Model tried to call unavailable tool 'get_weather'."),
  )

  assert.deepEqual(activity, {
    tool: 'get_weather',
    error: "Model tried to call unavailable tool 'get_weather'.",
  })
})

test('readInvalidToolActivity 兼容 input 是 JSON 字符串的路径', () => {
  const part: BridgePart = {
    type: 'tool',
    tool: INVALID_TOOL,
    state: {
      status: 'completed',
      input: JSON.stringify({ tool: 'get_weather', error: 'Invalid input for tool StructuredOutput' }),
    },
  }

  assert.deepEqual(readInvalidToolActivity(part), {
    tool: 'get_weather',
    error: 'Invalid input for tool StructuredOutput',
  })
})

test('readInvalidToolActivity 对坏 JSON 与缺失字段都不抛错', () => {
  const broken: BridgePart = {
    type: 'tool',
    tool: INVALID_TOOL,
    state: { status: 'completed', input: '{not json' },
  }
  assert.deepEqual(readInvalidToolActivity(broken), {})

  const empty: BridgePart = { type: 'tool', tool: INVALID_TOOL, state: { status: 'completed' } }
  assert.deepEqual(readInvalidToolActivity(empty), {})
})

test('readInvalidToolActivity 只认 invalid 工具', () => {
  const part: BridgePart = { type: 'tool', tool: 'bash', state: { status: 'completed', input: {} } }
  assert.equal(readInvalidToolActivity(part), null)
})

test('两种 invalid 来源被分开：点错工具名 vs 信封参数不合 schema', () => {
  // NoSuchToolError：模型把**外部工具名**当成原生工具发了
  assert.equal(
    classifyInvalidTool({
      tool: 'get_weather',
      error: "Model tried to call unavailable tool 'get_weather'. Available tools: StructuredOutput.",
    }),
    'unknown_tool',
  )

  // InvalidToolInputError：模型选对了 StructuredOutput，但参数过不了 schema
  assert.equal(
    classifyInvalidTool({
      tool: ENVELOPE_TOOL,
      error: 'Invalid input for tool StructuredOutput: Type validation failed',
    }),
    'bad_arguments',
  )

  // 认不出来就如实说认不出来，不猜
  assert.equal(classifyInvalidTool({ tool: 'x' }), 'unclassified')
  assert.equal(classifyInvalidTool({ tool: 'x', error: 'boom' }), 'unclassified')
})
