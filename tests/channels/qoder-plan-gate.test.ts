/**
 * Qoder 套餐档位闸门（业务码 112）的**线格式**回归测试。
 *
 * 背景（用户报障 2026-10-29，CN 渠道 `qodercn/dfmodel`）：上游在 HTTP 200 的
 * SSE 里回了一帧 `{code:112, message:"{…isHighestTier:false…}"}`，旧实现把它
 * 归成 `SERVER`，客户端只看到一坨裸 JSON + `(112/model_error)`，且被 harness
 * 白重试 5 次。
 *
 * 这里驱动的是**生产用的那份 vendor 源码**（经 esbuild 按
 * `scripts/build-channel-pack.mjs` 的同一套别名打包），不是它的复制品 ——
 * 断言点落在「客户端最终读到的错误码与文案」，而不是某个内部函数的实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VENDOR_SRC = join(ROOT, 'vendor', 'channel-pack', 'src')
const COMPAT_LLM = join(ROOT, 'src', 'main', 'channelPack', 'compat', 'dshLlm.ts')

/** 实测载荷（用户日志里那一帧，逐字保留）。 */
const TIER_PAYLOAD = JSON.stringify({
  isHighestTier: false,
  pricingUrl: 'https://qoder.com.cn/pricing?client=qoder',
})

const PRICING_URL = 'https://qoder.com.cn/pricing?client=qoder'

async function loadVendorBundle(t) {
  const esbuild = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'channel-pack-plan-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: [
        `export { consumeOpenAiSse } from ${JSON.stringify(join(VENDOR_SRC, 'openai-compat.ts'))}`,
        `export { unwrapQoderEnvelopeStream } from ${JSON.stringify(join(VENDOR_SRC, 'qoder-envelope.ts'))}`,
        `export { isPlanGateBusinessCode, looksLikePlanGate, planGateMessage } from ${JSON.stringify(join(VENDOR_SRC, 'qoder-plan-gate.ts'))}`,
        `export { LlmError } from ${JSON.stringify(COMPAT_LLM)}`,
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

function sseResponse(text) {
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

/** 消费一条 SSE 并返回 `{chunks, error}`（错误也当数据返回，便于断言）。 */
async function drain(iterable) {
  const chunks = []
  try {
    for await (const chunk of iterable) chunks.push(chunk)
    return { chunks, error: undefined }
  } catch (error) {
    return { chunks, error }
  }
}

const CONFIG = { label: 'qoder', firstTokenTimeoutMs: 5_000, chunkTimeoutMs: 5_000 }

test('信封里剥出的 112 帧被归成不可重试的 PERMISSION_DENIED，并给出升级链接', async (t) => {
  const { consumeOpenAiSse, unwrapQoderEnvelopeStream } = await loadVendorBundle(t)

  // 上游真实形态：SSE 每帧多一层信封，内层 body 是业务错误 JSON 字符串。
  const inner = JSON.stringify({ code: 112, message: TIER_PAYLOAD })
  const envelope = JSON.stringify({
    headers: {},
    body: inner,
    statusCodeValue: 200,
    statusCode: 'OK',
  })
  // ⚠️ 必须**按生产的顺序**走：`qoder-adapter.ts` 是
  // `consumeOpenAiSse(unwrapQoderEnvelopeStream(response, 'qoder'))` —— 先剥信封
  // 再消费。这里若把未剥的信卷直接喂给消费器，消费器只看到
  // `{headers, body, statusCodeValue}`（没有 `choices`、没有内层 `code`），
  // 于是整帧静默丢弃、流正常结束 —— 测出来的「失败」是测试自己的顺序错了，
  // 不是产品缺陷。
  const unwrapped = unwrapQoderEnvelopeStream(
    sseResponse(`data: ${envelope}\n\n`),
    'qoder',
  )
  const { error } = await drain(consumeOpenAiSse(unwrapped, {}, CONFIG))

  assert.ok(error, '112 必须抛错，不能静默结束')
  assert.equal(error.code, 'PERMISSION_DENIED', '必须是不可重试的权限错误，不能是 SERVER')
  assert.equal(error.failure?.status, 403, '上游语义是权限不足，状态码应为 403')
  assert.match(error.message, new RegExp(PRICING_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(error.message, /isHighestTier/, '文案里不能留裸 JSON')
  assert.doesNotMatch(error.message, /\(112\/model_error\)/, '文案里不能留旧的后缀')
})

test('没有信封的 112 帧（客户端日志里的原样）同样被识别', async (t) => {
  const { consumeOpenAiSse } = await loadVendorBundle(t)

  const frame = JSON.stringify({ code: 112, message: TIER_PAYLOAD, type: 'model_error' })
  const { error } = await drain(
    consumeOpenAiSse(sseResponse(`data: ${frame}\n\ndata: [DONE]\n\n`), {}, CONFIG),
  )

  assert.ok(error)
  assert.equal(error.code, 'PERMISSION_DENIED')
  assert.match(error.message, /不是最高档订阅/)
  assert.match(error.message, new RegExp(PRICING_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('信封剥掉 code 后只剩 message 的 112 帧也能识别（第二条通道）', async (t) => {
  const { consumeOpenAiSse } = await loadVendorBundle(t)

  const frame = JSON.stringify({ message: TIER_PAYLOAD, type: 'model_error' })
  const { error } = await drain(consumeOpenAiSse(sseResponse(`data: ${frame}\n\n`), {}, CONFIG))

  assert.ok(error)
  assert.equal(error.code, 'PERMISSION_DENIED')
  assert.match(error.message, new RegExp(PRICING_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('网关直接回 JSON（不是 SSE）时也给可读文案，而不是「原文片段」', async (t) => {
  const { consumeOpenAiSse } = await loadVendorBundle(t)

  const { error } = await drain(consumeOpenAiSse(sseResponse(TIER_PAYLOAD), {}, CONFIG))

  assert.ok(error)
  assert.equal(error.code, 'PERMISSION_DENIED')
  assert.match(error.message, /不是最高档订阅/)
  assert.doesNotMatch(error.message, /响应不是 SSE/)
})

test('负控：正常正文帧不受影响（新分支没有吞掉内容）', async (t) => {
  const { consumeOpenAiSse } = await loadVendorBundle(t)

  const text = [
    'data: {"choices":[{"delta":{"content":"hello"}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  const { chunks, error } = await drain(consumeOpenAiSse(sseResponse(text), {}, CONFIG))

  assert.equal(error, undefined)
  const emitted = chunks
    .filter(chunk => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
    .join('')
  assert.equal(emitted, 'hello')
})

test('判据只看专属字段名：模型正文里出现「升级套餐」不会被误判', async () => {
  // 这个模块**没有任何 import**，可以直接 import（不必过 esbuild）；
  // 纯判据/文案的回归因此在本机沙箱里也能跑。
  const { looksLikePlanGate, planGateMessage, isPlanGateBusinessCode } =
    await import(pathToFileURL(join(VENDOR_SRC, 'qoder-plan-gate.ts')).href)

  assert.equal(looksLikePlanGate('请升级套餐以解锁该模型'), false)
  assert.equal(looksLikePlanGate(TIER_PAYLOAD), true)
  assert.equal(isPlanGateBusinessCode(112), true)
  assert.equal(isPlanGateBusinessCode('112'), true)
  assert.equal(isPlanGateBusinessCode(110), false)

  // 没有 pricingUrl 时不编造链接，也不丢「要升级」这个语义。
  const withoutUrl = JSON.stringify({ isHighestTier: false })
  const message = planGateMessage(withoutUrl)
  assert.match(message, /不是最高档订阅/)
  assert.doesNotMatch(message, /https?:\/\//)
})

test('LlmError 把上游状态码落到 failure.status（垫片保真，非顶层丢失）', async () => {
  const { LlmError } = await import(pathToFileURL(COMPAT_LLM).href)

  const error = new LlmError('qoder: 套餐档位不足', 'PERMISSION_DENIED', { status: 403 })
  assert.equal(error.code, 'PERMISSION_DENIED')
  assert.equal(error.failure.status, 403)
  assert.equal(error.status, 403)

  const withoutStatus = new LlmError('qoder: 普通失败', 'SERVER')
  assert.equal(withoutStatus.failure, undefined)
})
