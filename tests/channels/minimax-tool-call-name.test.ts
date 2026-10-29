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
 * vendor 源码在 node --test 里**不能直接 import**（它依赖 `@deepseek-ai/dsh-llm`
 * 等虚拟模块，Node 解析不了）。这里用 esbuild 按 `scripts/build-channel-pack.mjs`
 * 的同一套别名打成一个临时 bundle 再 import —— 于是测试驱动的就是**生产用的那份
 * 源码**，而不是它的复制品。
 */
async function loadVendorBundle(t) {
  const esbuild = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'channel-pack-vendor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: [
        `export { consumeMinimaxSse } from ${JSON.stringify(join(VENDOR_SRC, 'minimax-messages.ts'))}`,
        `export { toOpenAiSse } from ${JSON.stringify(join(VENDOR_SRC, 'openai-gateway', 'stream.ts'))}`,
      ].join('\n'),
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

/** MiniMax 的 Anthropic Messages SSE：一次工具调用。 */
const TOOL_CALL_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"get_stock_price","input":{}}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"code\\":\\"002837\\"}"}}',
  '',
  'event: content_block_stop',
  'data: {"type":"content_block_stop","index":0}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n')

function sseStream(text) {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** 把网关投影出来的 SSE 文本解析回结构，便于断言。 */
function parseSseFrames(text) {
  return text
    .split('\n\n')
    .map(frame => frame.trim())
    .filter(frame => frame.startsWith('data: '))
    .map(frame => frame.slice('data: '.length))
    .filter(payload => payload !== '[DONE]')
    .map(payload => JSON.parse(payload) as Record<string, any>)
}

test('minimax 的工具调用在 OpenAI 形状的 tool_calls 里带上 function.name', async (t) => {
  const { consumeMinimaxSse, toOpenAiSse } = await loadVendorBundle(t)

  const chunks = []
  for await (const chunk of consumeMinimaxSse({ body: sseStream(TOOL_CALL_SSE) })) {
    chunks.push(chunk)
  }

  const frames = []
  for await (const frame of toOpenAiSse(
    (async function* () { yield* chunks })(),
    'chatcmpl-test',
    'minimax/model',
  )) {
    frames.push(frame)
  }

  const toolDeltas = parseSseFrames(frames.join(''))
    .flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])
    .filter((call: Record<string, unknown>) => call.function?.name !== undefined)

  assert.ok(
    toolDeltas.length > 0,
    '工具调用的 delta 必须带 function.name，否则客户端回传历史时被网关判成非法调用',
  )
  assert.equal(toolDeltas[0].function.name, 'get_stock_price')
  assert.equal(toolDeltas[0].id, 'toolu_01')
})

test('minimax 的工具调用参数照常透传（name 的修复没有吞掉 arguments）', async (t) => {
  const { consumeMinimaxSse, toOpenAiSse } = await loadVendorBundle(t)

  const chunks = []
  for await (const chunk of consumeMinimaxSse({ body: sseStream(TOOL_CALL_SSE) })) {
    chunks.push(chunk)
  }

  const frames = []
  for await (const frame of toOpenAiSse(
    (async function* () { yield* chunks })(),
    'chatcmpl-test',
    'minimax/model',
  )) {
    frames.push(frame)
  }

  const argumentsText = parseSseFrames(frames.join(''))
    .flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])
    .map((call: Record<string, any>) => call.function?.arguments ?? '')
    .join('')

  assert.equal(argumentsText, '{"code":"002837"}')
})
