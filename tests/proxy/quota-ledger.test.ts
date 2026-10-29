import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { QuotaLedger } from '../../src/main/proxy/quota/ledger.ts'

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'modelport-quota-'))
}

function usage(total: number) {
  return { promptTokens: Math.floor(total / 2), completionTokens: Math.ceil(total / 2), totalTokens: total }
}

/** 账本的保留与窗口全靠时刻，测试必须自带时钟，否则 flushSync 会按真实墙钟把记录剪掉。 */
function fixedLedger(nowMs: number, dir = tempDir()) {
  return { dir, ledger: new QuotaLedger(dir, () => nowMs) }
}

test('minute and day windows count requests and tokens separately', () => {
  const { ledger } = fixedLedger(T0 + 25 * HOUR + 2 * MINUTE)

  ledger.record('groq', 'a1', 'llama', usage(100), T0)
  ledger.record('groq', 'a1', 'llama', usage(50), T0 + 30_000)
  ledger.record('groq', 'a1', 'llama', usage(25), T0 + 25 * HOUR)

  const later = ledger.snapshot('groq', 'a1', 'llama')
  assert.equal(later.rpm, 0, 'nothing falls inside the last minute')
  assert.equal(later.tpm, 0)
  assert.equal(later.rpd, 1, 'the two records older than 24h have left the rolling day')
  assert.equal(later.tpd, 25)
  assert.equal(later.monthlyTokens, 175, 'the month total is not a 24h window')

  const insideMinute = ledger.snapshot('groq', 'a1', 'llama', T0 + 30_000)
  assert.equal(insideMinute.rpm, 2)
  assert.equal(insideMinute.tpm, 150)
})

test('the provider window sums every model of one account', () => {
  const { ledger } = fixedLedger(T0)

  ledger.record('open_router', 'a1', 'glm-5.2', usage(10), T0)
  ledger.record('open_router', 'a1', 'kimi-k2.6', usage(20), T0)
  ledger.record('open_router', 'a2', 'glm-5.2', usage(99), T0)

  const provider = ledger.providerSnapshot('open_router', 'a1')
  assert.equal(provider.rpm, 2)
  assert.equal(provider.tpm, 30, 'a second account must not leak into this one')
})

test('the month bucket follows the UTC calendar month', () => {
  const { ledger } = fixedLedger(T0)
  ledger.record('groq', 'a1', 'llama', usage(400), T0)
  ledger.record('groq', 'a1', 'llama', usage(600), T0 + 33 * DAY)

  assert.equal(ledger.snapshot('groq', 'a1', 'llama').monthlyTokens, 400)
  assert.equal(ledger.snapshot('groq', 'a1', 'llama', T0 + 33 * DAY).monthlyTokens, 600)
})

test('the ledger survives a restart', () => {
  const { dir, ledger } = fixedLedger(T0)
  ledger.record('cerebras', 'a1', 'qwen3', usage(77), T0)
  ledger.flushSync()

  const reopened = new QuotaLedger(dir, () => T0 + MINUTE)
  const snapshot = reopened.snapshot('cerebras', 'a1', 'qwen3')
  assert.equal(snapshot.rpm, 1)
  assert.equal(snapshot.tpm, 77)
  assert.equal(snapshot.monthlyTokens, 77)
})

test('a corrupted ledger is set aside instead of silently trusted or destroyed', () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'quota-ledger.json'), '{ this is not json', 'utf-8')

  const { ledger } = fixedLedger(T0, dir)
  assert.equal(ledger.snapshot('x', 'a', 'm').rpm, 0, 'startup continues on an empty ledger')

  const files = readdirSync(dir)
  assert.ok(
    files.some(name => name.startsWith('quota-ledger.corrupted.') && name.endsWith('.json')),
    `the unreadable file must be kept for proof, got ${files.join(', ')}`
  )
  assert.ok(!files.includes('quota-ledger.json'), 'the live path must not stay pointed at garbage')
})

test('pruning drops buckets and months that can no longer be in any window', () => {
  const now = T0 + 30 * DAY
  const { dir, ledger } = fixedLedger(now)
  ledger.record('groq', 'a1', 'llama', usage(5), T0)
  ledger.record('groq', 'a1', 'llama', usage(5), now)
  ledger.prune(now)
  ledger.flushSync()

  const persisted = JSON.parse(readFileSync(join(dir, 'quota-ledger.json'), 'utf-8')) as {
    minutes: Record<string, unknown>
    months: Record<string, unknown>
  }
  assert.equal(Object.keys(persisted.minutes).length, 1, 'the 30-day-old minute bucket must be gone')
  assert.deepEqual(Object.keys(persisted.months).sort(), ['2026-10', '2026-11'],
    'the current and the previous UTC month survive; anything older is dropped')
})

test('a month beyond the previous one no longer counts toward monthlyTokens', () => {
  const now = T0 + 90 * DAY
  const { ledger } = fixedLedger(now)
  ledger.record('groq', 'a1', 'llama', usage(500), T0)

  ledger.prune(now)
  assert.equal(ledger.snapshot('groq', 'a1', 'llama').monthlyTokens, 0)
})
