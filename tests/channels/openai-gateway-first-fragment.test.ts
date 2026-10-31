import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VENDOR_SRC = join(ROOT, 'vendor', 'channel-pack', 'src')
const COMPAT_LLM = join(ROOT, 'src', 'main', 'channelPack', 'compat', 'dshLlm.ts')

/**
 * 与 minimax-tool-call-name.test.ts 同一套基建：esbuild 按生产别名把 vendor
 * 源码打成临时 bundle 再 import —— 测试驱动的就是生产用的那份源码。
 */
async function loadVendorBundle(t) {
  const esbuild = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'channel-pack-vendor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: `export { toOpenAiSse } from ${JSON.stringify(join(VENDOR_SRC, 'openai-gateway', 'stream.ts'))}`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    logLevel: 'warning',
    alias: { '@deepseek-ai/dsh-llm': COMPAT_LLM },
  })
  return await import(pathToFileURL(outfile).href)
}

function parseSseFrames(text) {
  return text
    .split('\n\n')
    .map(frame => frame.trim())
    .filter(frame => frame.startsWith('data: '))
    .map(frame => frame.slice('data: '.length))
    .filter(payload => payload !== '[DONE]')
    .map(payload => JSON.parse(payload) as Record<string, any>)
}

/**
 * 2026-10-31 第七轮报障（本机 Qoder CN `incomplete_tool_replaced`）的复现流：
 * loomy/spark-x2.6 的 tool-call-delta 在**每个**分片上都重复携带完整 id+name
 * （DSH tool-call-delta 块天然带 callId）。这正是 ModelPort 02:59:37 请求
 * （chatcmpl-mvvc6lj7-cc9vg3）发给 Qoder 的真实形状。
 */
async function projectRepeatedIdStream(t) {
  const { toOpenAiSse } = await loadVendorBundle(t)
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: '让我先了解' },
    { type: 'reasoning-delta', index: 0, text: '用法。' },
    { type: 'tool-call-delta', index: 1, id: 'call_9740bee0', name: 'Skill', argumentsDelta: '' },
    { type: 'tool-call-delta', index: 1, id: 'call_9740bee0', name: 'Skill', argumentsDelta: '{"args":"创建团' },
    { type: 'tool-call-delta', index: 1, id: 'call_9740bee0', name: 'Skill', argumentsDelta: '队"}' },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const frames = []
  for await (const frame of toOpenAiSse(
    (async function* () { yield* chunks })(),
    'chatcmpl-test',
    'loomy/spark-x2.6',
  )) {
    frames.push(frame)
  }
  return parseSseFrames(frames.join(''))
}

test('重复 id 的分片流：id/type/name 只随首分片下发，后续分片只带 index+arguments', async (t) => {
  const toolDeltas = (await projectRepeatedIdStream(t))
    .flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])

  assert.equal(toolDeltas.length, 3, '三个 tool-call-delta 必须投影成三个 tool_calls 分片')

  const withId = toolDeltas.filter(call => call.id !== undefined)
  assert.equal(withId.length, 1, `只有首分片能带 id，收到 ${withId.length} 个带 id 的分片（Qoder 会当成新宣告替换累积中的调用）`)
  assert.equal(withId[0].id, 'call_9740bee0')
  assert.equal(withId[0].type, 'function')
  assert.equal(withId[0].function.name, 'Skill', '首分片必须带 function.name')

  for (const [i, call] of toolDeltas.entries()) {
    assert.equal(call.index, 0, `密集重编号：所有分片 index 必须是 0，收到 ${call.index}`)
    if (i > 0) {
      assert.equal(call.id, undefined, `第 ${i + 1} 个分片不能带 id`)
      assert.equal(call.function.name, undefined, `第 ${i + 1} 个分片不能带 name`)
    }
  }
})

test('重复 id 的分片流：arguments 增量原样拼接、finish_reason 照常下发', async (t) => {
  const frames = await projectRepeatedIdStream(t)

  const argumentsText = frames
    .flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])
    .map(call => call.function?.arguments ?? '')
    .join('')
  assert.equal(argumentsText, '{"args":"创建团队"}')

  const finish = frames.find(frame => frame.choices?.[0]?.finish_reason !== null
    && frame.choices?.[0]?.finish_reason !== undefined)
  assert.equal(finish?.choices?.[0]?.finish_reason, 'tool_calls')
})

test('OpenAI 惯例首块：role 先行、created 全流一致', async (t) => {
  const frames = await projectRepeatedIdStream(t)

  // role 首块必须是第一个内容帧（2026-10-31 审计项：官方流永远以它开场）。
  const first = frames[0]
  assert.equal(first.choices?.[0]?.delta?.role, 'assistant', `首帧必须是 role 块，收到 ${JSON.stringify(first.choices?.[0]?.delta)}`)
  assert.equal(first.choices?.[0]?.delta?.content, '')

  // created 全流共享同一个值（审计项：每帧现取会跨秒不一致）。
  const createdValues = new Set(frames.filter(f => f.created !== undefined).map(f => f.created))
  assert.equal(createdValues.size, 1, `全流 created 必须一致，收到 ${[...createdValues].join(',')}`)
})
