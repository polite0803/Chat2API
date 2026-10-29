import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AGGREGATE_QUOTA } from '../../src/shared/aggregateQuota.ts'
import { isFreePool, quotaRows, quotaViewOf } from '../../src/shared/aggregateQuotaView.ts'
import { AGGREGATE_REGISTRY, getAggregateEntry } from '../../src/main/providers/aggregate/registry.ts'

const entry = (id: string) => {
  const found = getAggregateEntry(id)
  assert.ok(found, `${id} must exist in the catalogue`)
  return found!
}

const zero = { rpm: 0, rpd: 0, tpm: 0, tpd: 0, monthlyTokens: 0 }

test('a keyed entry without a stored key never shows numbers', () => {
  const keyed = AGGREGATE_REGISTRY.find(e => e.authKind === 'apiKey' && e.id === 'groq')!
  const view = quotaViewOf(keyed, { hasApiKey: false })
  assert.equal(view.state, 'needs-key')
  assert.equal(view.used, undefined, 'nothing is metered, so nothing may be shown as used')
  assert.equal(view.limit, undefined)
})

test('needs-key outranks exhausted: without a key there is no usage to compare', () => {
  const keyed = entry('groq')
  const view = quotaViewOf(keyed, { hasApiKey: false, usage: { ...zero, rpd: 999_999 } })
  assert.equal(view.state, 'needs-key')
})

test('a documented entry shows its caps until the ledger reaches one', () => {
  const keyed = entry('sambanova')
  const quota = AGGREGATE_QUOTA.sambanova
  assert.equal(quota.source, 'documented', 'fixture precondition: sambanova has a documented cap')
  const limit = quota.rpd
  assert.ok(typeof limit === 'number' && limit > 0)

  const under = quotaViewOf(keyed, { hasApiKey: true, usage: { ...zero, rpd: limit - 1 } })
  assert.equal(under.state, 'documented')

  const at = quotaViewOf(keyed, { hasApiKey: true, usage: { ...zero, rpd: limit } })
  assert.equal(at.state, 'exhausted')
  assert.equal(at.exhaustedMetric, 'rpd')
  assert.equal(at.used, limit)
  assert.equal(at.limit, limit)
})

test('an entry with no published cap is reported as undocumented, not as blocked', () => {
  const free = entry('mistral')
  const quota = AGGREGATE_QUOTA.mistral
  assert.equal(quota?.source ?? 'undocumented', 'undocumented', 'fixture precondition')
  const view = quotaViewOf(free, { hasApiKey: true, usage: { ...zero, rpd: 999_999 } })
  assert.equal(view.state, 'undocumented')
  assert.equal(view.limit, undefined, 'an unpublished cap must not be rendered as a number')
})

test('the three absences stay distinguishable', () => {
  assert.equal(quotaViewOf(entry('groq'), { hasApiKey: false }).state, 'needs-key')
  assert.equal(quotaViewOf(entry('mistral'), { hasApiKey: true }).state, 'undocumented')
  assert.equal(quotaViewOf({ ...entry('mistral'), id: 'not_in_table' }, { hasApiKey: true }).state, 'absent')
})

test('the free-pool label comes from the catalogue, not from the quota data', () => {
  assert.equal(isFreePool(entry('bazaarlink')), true, 'category free-tier')
  assert.equal(isFreePool(entry('kilo')), true, 'key-less pool')
  assert.equal(isFreePool(entry('open_router')), true, 'free-tier category')
  assert.equal(isFreePool(entry('groq')), false, 'a plain keyed entry is not a free pool')
  assert.equal(isFreePool(entry('alibaba_cloud')), false)
})

test('quota rows only list the windows a provider actually published', () => {
  const rows = quotaRows('sambanova', { ...zero, rpd: 3 })
  const metrics = rows.map(row => row.metric).sort()
  assert.deepEqual(metrics, ['rpd', 'rpm', 'tpd'], 'sambanova publishes no TPM on its page')
  assert.equal(rows.find(row => row.metric === 'rpd')?.used, 3, 'the used column comes from the ledger')
  assert.equal(rows.find(row => row.metric === 'rpd')?.window, 'day', 'a per-day cap must not read like a monthly one')
  assert.equal(rows.find(row => row.metric === 'rpm')?.window, 'minute')

  assert.deepEqual(quotaRows('mistral'), [], 'an undocumented entry has no rows to draw')
  assert.deepEqual(quotaRows('not_in_table'), [])
})

test('a published cap in a non-token unit is shown as a note, never converted', () => {
  // cloudflare 的官方免费额度是 Neurons/天：数字进不了六个窗口，但必须能看见。
  const view = quotaViewOf(entry('cloudflare'), { hasApiKey: true, usage: zero })
  assert.equal(view.state, 'undocumented')
  assert.equal(view.limit, undefined, 'it must not be squeezed into a token window')
  assert.match(view.officialNote ?? '', /Neurons/, 'the vendor unit survives in the note')
  assert.deepEqual(quotaRows('cloudflare'), [], 'no fabricated token row')
})

test('the context window is exposed separately from the quota windows', () => {
  const view = quotaViewOf(entry('sambanova'), { hasApiKey: true, usage: zero })
  const quota = AGGREGATE_QUOTA.sambanova
  assert.equal(view.contextWindow, quota.contextWindow)
  assert.ok(typeof view.contextWindow === 'number')
})
