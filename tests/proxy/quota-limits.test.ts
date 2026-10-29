import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveCaps, evaluateQuota, quotaAvailability, type QuotaWindowUsage } from '../../src/main/proxy/quota/limits.ts'
import { learnFromHeaders, learnFromErrorBody, retryAfterSeconds } from '../../src/main/proxy/quota/observations.ts'
import { QuotaLedger } from '../../src/main/proxy/quota/ledger.ts'

const EMPTY_USAGE: QuotaWindowUsage = { rpm: 0, rpd: 0, tpm: 0, tpd: 0, monthlyTokens: 0 }

test('a documented entry becomes enforceable with its official caps', () => {
  const caps = resolveCaps('open_router', 'deepseek/deepseek-v3.1:free')
  assert.equal(caps.enforceable, true)
  assert.equal(caps.limits.rpm, 20)
  assert.equal(caps.limits.rpd, 50)
  assert.equal(caps.provenance.rpm, 'documented')
  assert.match(caps.docUrl ?? '', /^https:\/\/openrouter\.ai/)
})

test('an undocumented entry is never blocked, however much it has been used', () => {
  const caps = resolveCaps('mistral', 'mistral-large-latest')
  assert.equal(caps.enforceable, false, 'the catalogue has no number for this one')
  assert.deepEqual(caps.limits, {})

  const decision = evaluateQuota(caps, { rpm: 10_000, rpd: 10_000, tpm: 10_000_000, tpd: 10_000_000, monthlyTokens: 10_000_000 })
  assert.deepEqual(decision, { allowed: true }, 'no evidence must never mean "refuse"')
})

test('per-model numbers fill the axes the entry-level page left blank', () => {
  const entry = resolveCaps('baidu', 'glm-4.7')
  assert.equal(entry.limits.rpm, 60, 'the entry-level page publishes RPM')
  assert.equal(entry.limits.tpm, undefined, 'and nothing about TPM')

  const model = resolveCaps('baidu', 'glm-5.1')
  assert.equal(model.limits.tpm, 250_000)
  assert.equal(model.provenance.tpm, 'documented-model')
})

test('a learned cap can lower or fill, never raise', () => {
  const lowered = resolveCaps('open_router', 'x', { rpm: 5 })
  assert.equal(lowered.limits.rpm, 5)
  assert.equal(lowered.provenance.rpm, 'learned')

  const raised = resolveCaps('open_router', 'x', { rpm: 500, tpd: 1000 })
  assert.equal(raised.limits.rpm, 20, 'an optimistic observation must not lift the official ceiling')
  assert.equal(raised.limits.tpd, 1000, 'but it may fill an axis the official page never published')
})

test('the block reason names the window that is actually full', () => {
  const caps = resolveCaps('sambanova', 'Meta-Llama-3.3-70B-Instruct')
  assert.equal(caps.limits.rpd, 20)
  assert.equal(caps.limits.tpd, 200_000)

  const daily = evaluateQuota(caps, { ...EMPTY_USAGE, rpd: 20 })
  assert.equal(daily.allowed, false)
  assert.equal(daily.reason, 'rpd_exhausted')
  assert.equal(daily.limit, 20)

  const capped = resolveCaps('sambanova', 'Meta-Llama-3.3-70B-Instruct', { monthlyTokens: 5_000_000 })
  const both = evaluateQuota(capped, { ...EMPTY_USAGE, rpd: 20, tpd: 200_000, monthlyTokens: 5_000_000 })
  assert.equal(both.reason, 'monthly_exhausted', 'the hardest-to-recover window is reported first')

  const almost = evaluateQuota(caps, { ...EMPTY_USAGE, rpd: 19, tpd: 199_999 })
  assert.equal(almost.allowed, true, 'being under the cap by one must not block')
})

test('the availability label distinguishes the three kinds of absence', () => {
  assert.equal(quotaAvailability('cerebras'), 'documented')
  assert.equal(quotaAvailability('kimi'), 'undocumented')
  assert.equal(quotaAvailability('no_such_entry'), 'absent')
})

test('quota headers are read only in the shapes we recognised', () => {
  assert.deepEqual(learnFromHeaders({ 'x-ratelimit-limit-requests': '14', 'x-ratelimit-limit-tokens': '5000' }), [
    { metric: 'rpm', limit: 14, source: 'header' },
    { metric: 'tpm', limit: 5000, source: 'header' },
  ])
  assert.deepEqual(learnFromHeaders({ 'X-RateLimit-Limit-Requests-Day': '300' }), [
    { metric: 'rpd', limit: 300, source: 'header' },
  ], 'header names are matched case-insensitively')
  assert.deepEqual(learnFromHeaders({ 'x-ratelimit-limit-foo': '9' }), [], 'an unknown axis is not guessed')
  assert.deepEqual(learnFromHeaders({ 'x-ratelimit-limit-requests': 'unlimited' }), [])
  assert.deepEqual(learnFromHeaders(undefined), [])
})

test('a 429 body is only learned when its axis is unambiguous', () => {
  assert.deepEqual(learnFromErrorBody('Rate limit: 500 reached for requests per minute'), [
    { metric: 'rpm', limit: 500, source: 'error_body' },
  ])
  assert.deepEqual(learnFromErrorBody('limit 1000000 tokens per day exceeded'), [
    { metric: 'tpd', limit: 1_000_000, source: 'error_body' },
  ])
  assert.deepEqual(learnFromErrorBody('Daily limit: 20 requests per day'), [
    { metric: 'rpd', limit: 20, source: 'error_body' },
  ])
  assert.deepEqual(learnFromErrorBody('limit: 30'), [], 'no axis -> no learning; guessing the axis is worse than not learning')
  assert.deepEqual(learnFromErrorBody('too many requests, try later'), [])
  assert.deepEqual(learnFromErrorBody(undefined), [])
})

test('Retry-After is a wait, not a quota', () => {
  assert.equal(retryAfterSeconds({ 'retry-after': '30' }), 30)
  assert.equal(retryAfterSeconds({ 'Retry-After': '0' }), 0)
  assert.equal(retryAfterSeconds({ 'retry-after': 'soon' }), null)
})

test('learned caps survive a restart and never drift upward', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modelport-learn-'))
  const first = new QuotaLedger(dir)
  assert.equal(first.learn('groq', 'rpm', 70), true, 'fills an axis with no observation yet')
  assert.equal(first.learn('groq', 'rpm', 30), true, 'a smaller observation wins')
  assert.equal(first.learn('groq', 'rpm', 90), false, 'a bigger one is rejected')
  first.flushSync()

  const reopened = new QuotaLedger(dir)
  assert.deepEqual(reopened.learnedFor('groq'), { rpm: 30 })
  assert.equal(reopened.learn('groq', 'rpm', 45), false, 'the rule is not reset by a restart')

  const caps = resolveCaps('groq', 'llama-3.3-70b-versatile', reopened.learnedFor('groq'))
  assert.equal(caps.limits.rpm, 30)
})
