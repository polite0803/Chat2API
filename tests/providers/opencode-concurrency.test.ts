import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { TurnLimiter } from '../../src/main/opencode/concurrency.ts'
import { parseTurnFailureLine } from '../../src/main/opencode/bridge.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('闸门放行上限内的并发，其余排队', async () => {
  const limiter = new TurnLimiter(3)
  let running = 0
  let peak = 0
  const release: Array<() => void> = []

  const tasks = Array.from({ length: 8 }, () =>
    limiter.run(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise<void>(resolve => release.push(resolve))
      running--
      return 'done'
    }),
  )

  await new Promise(resolve => setImmediate(resolve))
  assert.equal(peak, 3, '最多三个回合同时在跑')
  assert.equal(limiter.queuedCount, 5, '其余的排队')

  // 逐个放行，全部完成
  while (release.length > 0) {
    release.shift()!()
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.deepEqual(await Promise.all(tasks), Array(8).fill('done'))
  assert.equal(limiter.activeCount, 0)
  assert.equal(limiter.queuedCount, 0)
})

test('闸门在任务失败时也会把名额还回去', async () => {
  const limiter = new TurnLimiter(1)

  await assert.rejects(
    limiter.run(async () => {
      throw new Error('boom')
    }),
    /boom/,
  )

  // 名额没被吃掉：下一个任务还能拿到
  assert.equal(await limiter.run(async () => 'ok'), 'ok')
  assert.equal(limiter.activeCount, 0)
})

test('运行时日志里的失败行只认自己的会话', () => {
  const line =
    'timestamp=2026-10-27T15:06:26.085Z level=ERROR run=639eb2dd message="stream error" ' +
    'providerID=opencode modelID=glm-5.3-flash-free session.id=ses_abc small=false agent=build ' +
    'mode=primary error.error="AI_APICallError: Free usage limit reached. Free models work in OpenCode"'

  const failure = parseTurnFailureLine(line, 'ses_abc')
  assert.ok(failure)
  assert.match(failure, /Free usage limit reached/)

  // 别的会话失败与我们无关
  assert.equal(parseTurnFailureLine(line, 'ses_other'), null)
  // 普通信息行不是失败
  assert.equal(parseTurnFailureLine('timestamp=... level=INFO message=loop session.id=ses_abc', 'ses_abc'), null)
})

test('闸门上限对齐客户端的扇出，别再把并发排成串行', () => {
  const source = readFileSync(join(root, 'src/main/opencode/service.ts'), 'utf8')

  // 调用方一轮发 10 个 agent 节点；闸门低于它就等于把等待时间乘上倍数
  assert.match(source, /const MAX_CONCURRENT_TURNS = 10\b/)
  assert.match(source, /new TurnLimiter\(MAX_CONCURRENT_TURNS\)/)
  // 旧的严格串行实现不许回来
  assert.doesNotMatch(source, /private queue: Promise<unknown>/)
})
