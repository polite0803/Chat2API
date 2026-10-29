/**
 * Qoder **会话身份**派生的回归测试。
 *
 * 背景：本适配器每轮重发全量历史，而 `session_id` 旧实现是每次
 * `crypto.randomUUID()` —— 每轮都是全新服务端会话，既没有会话记忆也命中不了
 * 前缀缓存，第 N 轮要为前 N-1 轮重新 prefill。这是「经本应用走 Qoder 明显比
 * IDE 慢」的主因，故改为按会话身份**确定性派生**。
 *
 * ⚠️ 与被打包进 vendor 的其它模块不同，`qoder-session.ts` **没有任何 import**
 * （只有 Node 全局 `Buffer`），因此可以直接 `import()` 而无需过 esbuild ——
 * 与 `qoder-plan-gate.test.ts` 最后那条用例同一理由：判据/派生这类纯逻辑的
 * 回归应当在任何沙箱里都能跑，不该被打包器的 spawn 权限绑住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VENDOR_SRC = join(ROOT, 'vendor', 'channel-pack', 'src')

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function loadSession() {
  return await import(pathToFileURL(join(VENDOR_SRC, 'qoder-session.ts')).href)
}

const BASE = {
  modelKey: 'qfmodel',
  accountSeed: 'uid-1',
  systemText: 'you are a coding agent',
  firstUserText: 'fix the failing test',
}

test('同一会话身份恒派生同一 session_id，且形态是 UUID（与旧实现一致）', async () => {
  const { deriveQoderSessionId } = await loadSession()
  const first = deriveQoderSessionId(BASE)
  assert.match(first, UUID_RE, '必须是 UUID 形态：上游字段本来就是 randomUUID()')
  assert.equal(first, deriveQoderSessionId({ ...BASE }))
})

test('generation 0 与「不传 generation」逐字同值（否则上线即全员换会话、缓存全丢）', async () => {
  const { deriveQoderSessionId } = await loadSession()
  assert.equal(
    deriveQoderSessionId({ ...BASE, generation: 0 }),
    deriveQoderSessionId(BASE),
  )
  assert.notEqual(deriveQoderSessionId({ ...BASE, generation: 1 }), deriveQoderSessionId(BASE))
})

test('每个身份维度都必须改变 session_id', async () => {
  const { deriveQoderSessionId } = await loadSession()
  const base = deriveQoderSessionId(BASE)
  // 模型：两个模型共用一个会话等于把缓存与路由搅在一起。
  assert.notEqual(base, deriveQoderSessionId({ ...BASE, modelKey: 'dmodel' }))
  // 账号：额度是「账号 + 模型」维度，换号必须换会话。
  assert.notEqual(base, deriveQoderSessionId({ ...BASE, accountSeed: 'uid-2' }))
  assert.notEqual(base, deriveQoderSessionId({ ...BASE, systemText: 'other prompt' }))
  assert.notEqual(base, deriveQoderSessionId({ ...BASE, firstUserText: 'another question' }))
})

test('「字段缺省」与「字段为空串」不得落进同一会话', async () => {
  const { deriveQoderSessionId } = await loadSession()
  // 未下发 system 与下发空 system 是两种语义；混同会让两类请求共用一个服务端会话。
  assert.notEqual(
    deriveQoderSessionId({ modelKey: 'qfmodel', firstUserText: 'hi' }),
    deriveQoderSessionId({ modelKey: 'qfmodel', systemText: '', firstUserText: 'hi' }),
  )
})

test('会话身份取**首条** user 文本，不是最后一条', async () => {
  const { firstUserTextOf } = await loadSession()
  const messages = [
    { role: 'system', content: 'ignore' },
    { role: 'user', content: '第一轮的问题' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '本轮的问题' },
  ]
  // 用最后一条派生等于每轮一个新会话 —— 那正是被修掉的旧行为。
  assert.equal(firstUserTextOf(messages), '第一轮的问题')
  // 多模态数组只取 text part。
  assert.equal(
    firstUserTextOf([{ role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: '带图的提问' }] }]),
    '带图的提问',
  )
  assert.equal(firstUserTextOf([{ role: 'assistant', content: 'x' }]), '')
})

test('会话冲突判据只认「上游在讲会话/上下文长度」，绝不认额度与排队', async () => {
  const { looksLikeSessionConflict } = await loadSession()

  assert.equal(looksLikeSessionConflict('session expired, please start a new one'), true)
  assert.equal(looksLikeSessionConflict('invalid session'), true)
  assert.equal(looksLikeSessionConflict('Range of input length should be [1, 983616]'), true)
  assert.equal(looksLikeSessionConflict('The input token count exceeds the maximum number of tokens allowed'), true)

  // ⚠️ 反向必须成立：这三类各有**正确**处置路径（10605 排队、110 额度、112 套餐）。
  // 把它们当成会话冲突会让换代吞掉真因，并反复重打整笔加密请求。
  assert.equal(looksLikeSessionConflict('模型排队中'), false)
  assert.equal(looksLikeSessionConflict('Billing daily count exceeded'), false)
  assert.equal(
    looksLikeSessionConflict('{"isHighestTier":false,"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"}'),
    false,
  )
  assert.equal(looksLikeSessionConflict('First Token Timeout or Upstream Timeout'), false)
  assert.equal(looksLikeSessionConflict('Signature invalid'), false)
  assert.equal(looksLikeSessionConflict(''), false)
})
