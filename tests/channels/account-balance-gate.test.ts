/**
 * 账号余额门控（`account-balance-gate.ts`）的回归测试。
 *
 * 背景：全渠道审计（2026-10-30）确认除 loomy / buddy 外，选号都不知道积分
 * 余额，0 积分号霸占首位会让请求反复失败。门控的契约核心是：
 *
 * 1. **只拦「确认为 0」**：正余额放行、0/负数拦截；
 * 2. **fail-open**：查询失败 / 超时 / 返回 null 一律放行（绝不因查询抖动
 *    把有积的号排掉）；
 * 3. **TTL 缓存 + 并发去重**：选号热路径基本零网络开销；
 * 4. 环境开关 `DSH_ACCOUNT_BALANCE_GATE` 可整体停用。
 *
 * ⚠️ 被测模块**零 import**，可直接以 TS 源动态加载（同 queue-wait.test.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const VENDOR_SRC = join(ROOT, 'vendor', 'channel-pack', 'src')

async function loadGate() {
  return await import(pathToFileURL(join(VENDOR_SRC, 'account-balance-gate.ts')).href)
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))

test('正余额放行，0 与负数确认为「空」并拦截', async () => {
  const { AccountBalanceGate } = await loadGate()
  for (const balance of [0, -1, -0.0001]) {
    const gate = new AccountBalanceGate({ probe: async () => balance })
    assert.equal(await gate.usable('a', {}), false, `余额 ${balance} 必须拦截`)
  }
  for (const balance of [1, 0.0001, Number.MAX_SAFE_INTEGER]) {
    const gate = new AccountBalanceGate({ probe: async () => balance })
    assert.equal(await gate.usable('a', {}), true, `余额 ${balance} 必须放行`)
  }
})

test('fail-open：probe 返回 null/undefined 或抛错 → undefined（放行）', async () => {
  const { AccountBalanceGate } = await loadGate()
  assert.equal(await new AccountBalanceGate({ probe: async () => null }).usable('a', {}), undefined)
  assert.equal(await new AccountBalanceGate({ probe: async () => undefined }).usable('a', {}), undefined)
  assert.equal(
    await new AccountBalanceGate({ probe: async () => { throw new Error('boom') } }).usable('a', {}),
    undefined,
    'probe 抛错必须放行而不是拦截',
  )
  assert.equal(await new AccountBalanceGate({ probe: async () => NaN }).usable('a', {}), undefined)
})

test('TTL 缓存：窗口内 probe 只调一次，过期后重查', async () => {
  const { AccountBalanceGate } = await loadGate()
  let now = 1_000
  let calls = 0
  const gate = new AccountBalanceGate({
    probe: async () => { calls += 1; return calls === 1 ? 0 : 5 },
    ttlMs: 60_000,
    now: () => now,
  })
  assert.equal(await gate.usable('a', {}), false)
  now += 59_999
  assert.equal(await gate.usable('a', {}), false, '缓存窗口内不得重查')
  assert.equal(calls, 1)
  now += 1
  assert.equal(await gate.usable('a', {}), true, '过期后必须重查并拿到新值')
  assert.equal(calls, 2)
})

test('失败结果用短 TTL：5 秒内不再打，过期后重试', async () => {
  const { AccountBalanceGate } = await loadGate()
  let now = 1_000
  let calls = 0
  const gate = new AccountBalanceGate({
    probe: async () => { calls += 1; throw new Error('network down') },
    errorTtlMs: 5_000,
    now: () => now,
  })
  assert.equal(await gate.usable('a', {}), undefined)
  now += 4_999
  assert.equal(await gate.usable('a', {}), undefined)
  assert.equal(calls, 1, '失败缓存窗口内不得重试')
  now += 1
  await gate.usable('a', {})
  assert.equal(calls, 2, '失败缓存过期后必须重试')
})

test('并发去重：同一账号的并发查询只触发一次 probe', async () => {
  const { AccountBalanceGate } = await loadGate()
  let calls = 0
  const gate = new AccountBalanceGate({
    probe: async () => { calls += 1; await tick(); await tick(); return 0 },
  })
  const [first, second] = await Promise.all([gate.usable('a', {}), gate.usable('a', {})])
  assert.equal(first, false)
  assert.equal(second, false)
  assert.equal(calls, 1, '并发查询必须共享同一次 probe')
})

test('probe 超时按「查不到」处理（fail-open），不阻塞选号', async () => {
  const { AccountBalanceGate } = await loadGate()
  const gate = new AccountBalanceGate({
    probe: () => new Promise(() => { /* 永不 resolve */ }),
    probeTimeoutMs: 20,
  })
  assert.equal(await gate.usable('a', {}), undefined, '超时必须放行')
})

test('invalidate 清除指定账号（或全部）缓存', async () => {
  const { AccountBalanceGate } = await loadGate()
  let calls = 0
  const gate = new AccountBalanceGate({ probe: async () => { calls += 1; return 0 } })
  await gate.usable('a', {})
  await gate.usable('b', {})
  assert.equal(calls, 2)
  gate.invalidate('a')
  await gate.usable('a', {})
  await gate.usable('b', {})
  assert.equal(calls, 3, '只有 a 被清，b 仍走缓存')
  gate.invalidate()
  await gate.usable('a', {})
  assert.equal(calls, 4, '全清后 a 重新查询')
})

test('环境开关：默认开启，0/false/no/off 停用，其余视为开启', async () => {
  const { isBalanceGateEnabled } = await loadGate()
  for (const raw of [undefined, '', '1', 'true', 'yes', 'ON', ' on ']) {
    assert.equal(isBalanceGateEnabled(raw), true, `raw=${JSON.stringify(raw)} 应开启`)
  }
  for (const raw of ['0', 'false', 'no', 'off', ' OFF ', 'No']) {
    assert.equal(isBalanceGateEnabled(raw), false, `raw=${JSON.stringify(raw)} 应停用`)
  }
})
