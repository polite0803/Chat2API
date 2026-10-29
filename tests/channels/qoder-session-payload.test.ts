/**
 * Qoder 加密请求体里 **`session_id` 的线格式**回归测试。
 *
 * 这条必须与 `qoder-session.test.ts` 分开：那个文件只测**零依赖纯函数**，
 * 因而能在任何沙箱里跑；本文件要读 `qoder-wasm.ts`，而它带 TS 参数属性
 * （`private readonly g: Glue`），Node 的 strip-only 模式**无法直接 import**
 * （`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`）—— 与 `qoder-plan-gate.test.ts` 同一
 * 处境，所以走 esbuild 打包。
 *
 * ⚠️ 因此本文件属于「禁 spawn 的沙箱里跑不了」那一类（esbuild 要起服务进程），
 * 报红时先确认是不是 `spawn EPERM`，不要照此改产品代码。
 *
 * 钉的是**接线**而不是算法：适配器算出的会话身份必须真的落到请求体上，
 * 否则派生函数再正确也只是死代码（`tools` 不下发那个缺陷的同型教训 ——
 * 判据在 A 处算好，B 处却仍然随机生成）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VENDOR_SRC = join(ROOT, 'vendor', 'channel-pack', 'src')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function loadVendorBundle(t: { after(fn: () => unknown): void }) {
  const esbuild = await import('esbuild')
  const dir = mkdtempSync(join(tmpdir(), 'channel-pack-qoder-session-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outfile = join(dir, 'bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: `export { buildQoderInferPayload } from ${JSON.stringify(join(VENDOR_SRC, 'qoder-wasm.ts'))}`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node20'],
    logLevel: 'warning',
  })
  return await import(pathToFileURL(outfile).href)
}

/** 适配器实际会传的最小入参形状（其余字段与本题无关）。 */
const ASK = { modelKey: 'qfmodel', userText: 'fix the failing test' }

test('适配器给了 sessionId，请求体就必须用它（不能自己再随机一次）', async (t) => {
  const { buildQoderInferPayload } = await loadVendorBundle(t)
  const payload = buildQoderInferPayload({ ...ASK, sessionId: 'stable-session-id' })
  assert.equal(payload.session_id, 'stable-session-id')
})

test('没给时才回退随机 UUID（旧行为，仅兼容既有调用方与单测）', async (t) => {
  const { buildQoderInferPayload } = await loadVendorBundle(t)
  const a = buildQoderInferPayload(ASK)
  const b = buildQoderInferPayload(ASK)
  assert.match(String(a.session_id), UUID_RE, '回退值仍须是 UUID 形态：上游字段一直是 randomUUID()')
  assert.notEqual(a.session_id, b.session_id)
})

test('request_id 恒 per-request，且不与 session_id 混同', async (t) => {
  const { buildQoderInferPayload } = await loadVendorBundle(t)
  const a = buildQoderInferPayload({ ...ASK, sessionId: 'stable-session-id' })
  const b = buildQoderInferPayload({ ...ASK, sessionId: 'stable-session-id' })
  // 同一会话、两次请求：会话相同，请求身份必须不同 —— 否则会触发服务端判重
  // （客户端的 `duplicate_request` 通道就是为这件事存在的）。
  assert.equal(a.session_id, b.session_id)
  assert.notEqual(a.request_id, b.request_id)
  assert.notEqual(a.request_id, a.session_id)
  assert.equal(a.request_set_id, a.request_id)
  assert.equal(a.chat_record_id, a.request_id)
})
