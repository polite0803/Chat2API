/**
 * 排队**等待切分**的回归测试。
 *
 * 背景：旧实现把服务端声明的延迟**截到 10 秒**后回循环顶部**重发整笔请求**。
 * 服务端回 `retryAfterSeconds: 30` 时那是 3 发完整加密请求 + 3 次全量 prefill，
 * 其中 2 次的 prefill 完全白烧；而它换来的收益只有「单次阻塞别超过 10 秒」
 * 这一条 UI 诉求。把同一个 30 秒**切成 3 片连续睡满、只重发一次**，两条诉求
 * 同时成立 —— 这里钉的就是这个切分规则。
 *
 * ⚠️ `queue-wait.ts` 无任何 import（纯算术），故可直接 `import()` 而无需过
 * esbuild；这也意味着本文件在禁 spawn 的沙箱里照样能跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VENDOR_SRC = join(ROOT, 'vendor', 'channel-pack', 'src')

async function loadQueueWait() {
  return await import(pathToFileURL(join(VENDOR_SRC, 'queue-wait.ts')).href)
}

const CONFIG = { sliceMs: 10_000, maxDeclaredMs: 30_000, fallbackMs: 1_000 }

test('服务端说等 30 秒 → 等满 30 秒，且**只重发一次**（切成 3 片）', async () => {
  const { planQueueWait, totalQueueWaitMs } = await loadQueueWait()
  const slices = planQueueWait(30_000, CONFIG)
  assert.deepEqual(slices, [10_000, 10_000, 10_000])
  assert.equal(totalQueueWaitMs(slices), 30_000, '总等待必须等于服务端要求值')
  // 一次计划 = 一次重发。旧实现是 3 次（每片后立刻重发整笔请求）。
  assert.equal(slices.length, 3, '片数只影响 sleep 粒度')
})

test('每片都不超过单次上限，短延迟不切分', async () => {
  const { planQueueWait } = await loadQueueWait()
  assert.deepEqual(planQueueWait(2_000, CONFIG), [2_000])
  assert.deepEqual(planQueueWait(25_000, CONFIG), [10_000, 10_000, 5_000])
  for (const value of [30_000, 29_999, 12_345, 100]) {
    for (const slice of planQueueWait(value, CONFIG)) {
      assert.ok(slice <= CONFIG.sliceMs, `${value} 的一片 ${slice} 超了单次上限`)
      assert.ok(slice >= 100, `${value} 的一片 ${slice} 短到可能变成忙循环`)
    }
  }
})

test('尾片过短时并入前一片，不留 1 毫秒碎片', async () => {
  const { planQueueWait, totalQueueWaitMs } = await loadQueueWait()
  assert.deepEqual(planQueueWait(10_050, CONFIG), [10_050])
  assert.deepEqual(planQueueWait(20_050, CONFIG), [10_000, 10_050])
  assert.equal(totalQueueWaitMs(planQueueWait(10_050, CONFIG)), 10_050)
})

test('服务端说 0 → 仍保留极短一片，不忙等', async () => {
  const { planQueueWait } = await loadQueueWait()
  assert.deepEqual(planQueueWait(0, CONFIG), [100])
})

test('拿不到延迟 → 一片保守退避（与客户端 W7c 同口径）', async () => {
  const { planQueueWait } = await loadQueueWait()
  assert.deepEqual(planQueueWait(undefined, CONFIG), [1_000])
  // 非法值一律按「没给」处理，而不是当 0（当 0 会变成忙循环烧掉机会）。
  assert.deepEqual(planQueueWait(-5, CONFIG), [1_000])
  assert.deepEqual(planQueueWait(Number.NaN, CONFIG), [1_000])
  assert.deepEqual(planQueueWait(Number.POSITIVE_INFINITY, CONFIG), [1_000])
})

test('超过采信上限的延迟按上限等，总封顶仍由调用方的 deadline 负责', async () => {
  const { planQueueWait, totalQueueWaitMs } = await loadQueueWait()
  const slices = planQueueWait(600_000, CONFIG)
  assert.equal(totalQueueWaitMs(slices), CONFIG.maxDeclaredMs)
})

test('sliceMs=0 表示不切分（排查用；整段一次睡完）', async () => {
  const { planQueueWait } = await loadQueueWait()
  assert.deepEqual(planQueueWait(30_000, { ...CONFIG, sliceMs: 0 }), [30_000])
})

test('默认常量：单片 10 秒与历史 QUEUE_MAX_DELAY_MS 同值', async () => {
  const { DEFAULT_QUEUE_SLICE_MS, DEFAULT_QUEUE_MAX_DECLARED_MS } = await loadQueueWait()
  assert.equal(DEFAULT_QUEUE_SLICE_MS, 10_000)
  assert.equal(DEFAULT_QUEUE_MAX_DECLARED_MS, 30_000)
})
