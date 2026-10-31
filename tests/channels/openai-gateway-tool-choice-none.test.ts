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
 * 2026-10-31 报障（本机 Qoder CN，auto → minimax/MiniMax-M3 返回 400
 * `tool_choice none with tools cannot be represented by DSH`）的回归：
 *
 * `tool_choice:'none'` + 非空 `tools` 是 OpenAI 规范里的**合法**组合（工具在
 * 上下文、但本轮禁止调用），Qoder 对摘要/命名类子请求就会这么发。DSH 的
 * GenerateOptions 没有 tool_choice 字段，网关原先直接回 400，整轮对话报废。
 * 修复：丢弃 tools 降级放行（trae.ts normalizeToolChoice 同判据）。
 *
 * 与 openai-gateway-first-fragment.test.ts 同一套基建：esbuild 按生产别名把
 * vendor 源码打成临时 bundle 再 import —— 测试驱动的就是生产用的那份源码。
 */
async function loadVendorBundle(t) {
  const esbuild = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'channel-pack-vendor-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: [
        `export { toGenerateOptions } from ${JSON.stringify(join(VENDOR_SRC, 'openai-gateway', 'messages.ts'))}`,
        `export { toResponsesGenerateOptions } from ${JSON.stringify(join(VENDOR_SRC, 'openai-gateway', 'responses.ts'))}`,
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

const CHAT_TOOLS = [{
  type: 'function',
  function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: {} } },
}]

const RESPONSES_TOOLS = [{
  type: 'function',
  name: 'get_weather',
  description: '查天气',
  parameters: { type: 'object', properties: {} },
}]

function chatBody(overrides = {}) {
  return {
    model: 'minimax/MiniMax-M3',
    messages: [{ role: 'user', content: '总结这段对话' }],
    ...overrides,
  }
}

function responsesBody(overrides = {}) {
  return {
    model: 'minimax/MiniMax-M3',
    input: '总结这段对话',
    ...overrides,
  }
}

test('chat：tool_choice none + tools 不再 400，tools 被丢弃降级放行', async (t) => {
  const { toGenerateOptions } = await loadVendorBundle(t)
  const options = await toGenerateOptions(
    chatBody({ tool_choice: 'none', tools: CHAT_TOOLS }),
    new AbortController().signal,
  )
  assert.equal(options.tools, undefined, 'none 语义下 tools 必须整体不下发')
  assert.equal(options.model, 'MiniMax-M3')
})

test('chat：tool_choice auto + tools 照常下发（降级只针对 none）', async (t) => {
  const { toGenerateOptions } = await loadVendorBundle(t)
  const options = await toGenerateOptions(
    chatBody({ tool_choice: 'auto', tools: CHAT_TOOLS }),
    new AbortController().signal,
  )
  assert.equal(options.tools?.length, 1)
  assert.equal(options.tools?.[0]?.name, 'get_weather')
})

test('chat：不带 tool_choice 时 tools 校验照旧（坏 tool 仍报错）', async (t) => {
  const { toGenerateOptions } = await loadVendorBundle(t)
  await assert.rejects(
    () => toGenerateOptions(
      chatBody({ tools: [{ type: 'web_search' }] }),
      new AbortController().signal,
    ),
    /only function tools are supported/,
  )
})

test('responses：tool_choice none + tools 同判据，tools 被丢弃降级放行', async (t) => {
  const { toResponsesGenerateOptions } = await loadVendorBundle(t)
  const options = await toResponsesGenerateOptions(
    responsesBody({ tool_choice: 'none', tools: RESPONSES_TOOLS }),
    new AbortController().signal,
  )
  assert.equal(options.tools, undefined, 'none 语义下 tools 必须整体不下发')
  assert.equal(options.model, 'MiniMax-M3')
})

test('responses：tool_choice auto + tools 照常下发（降级只针对 none）', async (t) => {
  const { toResponsesGenerateOptions } = await loadVendorBundle(t)
  const options = await toResponsesGenerateOptions(
    responsesBody({ tool_choice: 'auto', tools: RESPONSES_TOOLS }),
    new AbortController().signal,
  )
  assert.equal(options.tools?.length, 1)
  assert.equal(options.tools?.[0]?.name, 'get_weather')
})
