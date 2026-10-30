/**
 * 换家判据的回归测试（纯函数 + 真实流行为，无 electron、无网络）。
 *
 * 背景（用户报障 2026-10-30）：客户端 harness 带着上百个工具走 auto，命中
 * cline（上游 Vercel AI Gateway 硬限 tools ≤ 128）直接 400，且这个失败原先
 * 以「流内错误帧」浮现 —— auto 的换家机制看不到，整场失败。修复后：
 * 1. 账号渠道流式路径等「首块 vs 首错」，建流阶段的失败转成普通 ForwardResult；
 * 2. 工具数超限类 400 判为可换家（渠道装不下，账号本身无过）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PassThrough } from 'stream'

import { firstStreamEvent, isFailoverEligibleStatus, isToolOverflowError } from '../../src/main/proxy/failover.ts'

const forwarderSource = readFileSync('src/main/proxy/forwarder.ts', 'utf-8')

test('工具数超限识别：命中用户报障的上游原文', () => {
  // 用户报障原文（cline / Vercel AI Gateway 400 的 error.message 片段）
  assert.ok(isToolOverflowError(
    "Invalid value for 'tools': maximum number of items is 128.",
  ))
  // 大小写不敏感 + 变体措辞
  assert.ok(isToolOverflowError('Too many tools provided: 150 > 128'))
  assert.ok(isToolOverflowError('tools: too many items'))
})

test('工具数超限识别：窄口径，无关 400 不得误判', () => {
  assert.equal(isToolOverflowError(undefined), false)
  assert.equal(isToolOverflowError(''), false)
  // 没提 tools 语境的超限（如消息条数超限）不算
  assert.equal(isToolOverflowError('maximum number of messages is 128'), false)
  // 提了 tools 但不是数量问题（如 schema 校验失败）不算
  assert.equal(isToolOverflowError("Invalid value for 'tools': schema is invalid"), false)
  // 普通业务错误不算
  assert.equal(isToolOverflowError('model not found'), false)
})

test('firstStreamEvent：建流失败在首块之前到达时，以 error 浮现并带上状态码', () => {
  const stream = new PassThrough()
  const pending = firstStreamEvent(stream)
  stream.destroy(Object.assign(new Error('cline: 400 tools overflow'), { status: 400 }))
  return pending.then((first) => {
    assert.equal(first.kind, 'error')
    if (first.kind !== 'error') return
    assert.equal((first.error as { status?: number }).status, 400)
    assert.match(first.error.message, /tools overflow/)
  })
})

test('firstStreamEvent：首块原样交还，后续块经 pipe 完整续传（不丢块）', async () => {
  const stream = new PassThrough()
  const pending = firstStreamEvent(stream)
  stream.write('data: first\n\n')
  const first = await pending
  assert.equal(first.kind, 'data')
  if (first.kind !== 'data') return

  const target = new PassThrough()
  let received = ''
  target.on('data', (chunk) => { received += chunk.toString() })
  const ended = new Promise<void>(resolve => target.once('end', resolve))
  // 与 forwardAccountChannel 相同的接法：首块补发 + pipe 接管
  target.write(first.chunk)
  stream.pipe(target)
  stream.write('data: second\n\n')
  stream.end()
  await ended
  assert.equal(received, 'data: first\n\ndata: second\n\n')
})

test('firstStreamEvent：未产出任何数据就关闭（含无错误销毁）判为 closed', async () => {
  const destroyed = new PassThrough()
  const pendingDestroyed = firstStreamEvent(destroyed)
  destroyed.destroy()
  assert.equal((await pendingDestroyed).kind, 'closed')

  const ended = new PassThrough()
  const pendingEnded = firstStreamEvent(ended)
  ended.end()
  assert.equal((await pendingEnded).kind, 'closed')
})

test('forwarder 的换家判据必须接上：超限 400 参与换家，普通 400 仍然直接失败', () => {
  // 钉调用点：forwardFirstReachable 在 4xx 判定之前先查工具超限
  assert.match(
    forwarderSource,
    /const toolOverflow = isToolOverflowError\(result\.error\)/,
    'forwardFirstReachable must consult isToolOverflowError before rejecting failover',
  )
  // 钉不变量：普通 4xx（非超限）依旧不可换家 —— 这条语义不许被顺手改掉
  assert.equal(isFailoverEligibleStatus(400), false)
  assert.equal(isFailoverEligibleStatus(429), true)
  assert.equal(isFailoverEligibleStatus(502), true)
})

test('forwarder 的流式路径必须等首事件再定成败（建流失败要能进换家循环）', () => {
  assert.match(
    forwarderSource,
    /const first = await firstStreamEvent\(upstream\)/,
    'account-channel streaming must await the first stream event before declaring success',
  )
})
