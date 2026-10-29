import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const page = readFileSync(join(root, 'src/renderer/src/pages/Aggregate.tsx'), 'utf8')
const detail = readFileSync(
  join(root, 'src/renderer/src/components/aggregate/AggregateDetail.tsx'),
  'utf8'
)
const locales = ['zh-CN', 'en-US'].map(name => ({
  name,
  aggregate: JSON.parse(
    readFileSync(join(root, `src/renderer/src/i18n/locales/${name}.json`), 'utf8')
  ).aggregate,
}))

const STATES = ['needs-key', 'exhausted', 'documented', 'undocumented', 'absent']
const METRICS = ['rpm', 'rpd', 'tpm', 'tpd', 'monthlyTokens']

test('每一种缺席都有自己的句子，不是"可用/不可用"两态', () => {
  assert.match(detail, /t\(`aggregate\.quota\.\$\{view\.state\}`\)/,
    'the sentence must come from the state template, so every state gets its own text')
  assert.doesNotMatch(detail, /view\.state === 'documented'\s*\?[^\n]*t\('aggregate\.quota/,
    'a ternary over states would collapse the five sentences into two')
})

test('两个语言各写全五态与五个单位，插值槽完整', () => {
  for (const { name, aggregate } of locales) {
    for (const state of STATES) {
      assert.equal(typeof aggregate.quota?.[state], 'string', `${name} 缺 aggregate.quota.${state}`)
      assert.ok(aggregate.quota[state].length > 4, `${name} 的 ${state} 是一句空话`)
    }
    for (const metric of METRICS) {
      assert.equal(typeof aggregate.metric?.[metric], 'string', `${name} 缺 aggregate.metric.${metric}`)
    }
    const slots = (text) => (text.match(/{{\s*[\w.]+\s*}}/g) ?? []).sort().join(',')
    assert.equal(slots(aggregate.quotaUsage), '{{limit}},{{metric}},{{used}},{{window}}',
      `${name} 的用量句必须带 metric/used/limit/window 四个槽`)
    assert.equal(slots(aggregate.quotaSource), '{{date}}', `${name} 的出处句必须带日期`)
    assert.equal(slots(aggregate.quotaContext), '{{tokens}}', `${name} 的上下文句必须带 token 数`)
    assert.equal(typeof aggregate.columnQuota, 'string', `${name} 缺表头`)
    for (const window of ['minute', 'day', 'month']) {
      assert.equal(typeof aggregate.window?.[window], 'string', `${name} 缺 aggregate.window.${window}`)
    }
  }
})

test('免费配额按状态着色，免费池标签自带同色系底', () => {
  assert.match(detail, /view\.isFreePool && \(/,
    'the free-pool label is conditional on the catalogue flag')
  assert.match(detail, /view\.state === 'documented'[\s\S]{0,200}emerald/,
    'documented caps read as healthy')
  assert.match(detail, /view\.state === 'undocumented'[\s\S]{0,160}amber/,
    'an unpublished cap reads as a caveat, not as a failure')
  assert.match(detail, /view\.state === 'exhausted'[\s\S]{0,160}destructive/,
    'only an exhausted window turns red')
  assert.match(detail, /bg-emerald-100 text-emerald-700/, 'the free-pool badge carries the same colour family')
})

test('聚合页是主从布局：左侧分组列表，右侧详情', () => {
  assert.match(page, /grid items-start gap-4 lg:grid-cols-\[320px_minmax\(0,1fr\)\]/,
    'the page must be a list/detail split, like the provider management page')
  assert.match(page, /<AggregateDetailPanel/, 'the right pane is the shared detail panel')
  for (const key of ['sectionEnabled', 'sectionDisabled', 'sectionAvailable']) {
    assert.match(page, new RegExp(`aggregate\\.manage\\.${key}`),
      `the left list must group entries into ${key}`)
  }
})

test('每个数字都带窗口口径，官方原单位照实显示', () => {
  assert.match(detail, /aggregate\.window\.\$\{WINDOW_OF_METRIC\[row\.metric\]\}/,
    'each documented row must say which window the number belongs to')
  assert.match(detail, /aggregate\.window\.\$\{WINDOW_OF_METRIC\[view\.exhaustedMetric\]\}/,
    'the exhausted sentence must name its window too')
  assert.match(detail, /view\.officialNote[\s\S]{0,220}aggregate\.quotaScopeNote/,
    'the vendor note (non-token units, conditions) must be rendered, not dropped')
  assert.match(detail, /title=\{view\.officialNote\}/,
    'the full note stays reachable even when the line clamps it')

  const card = readFileSync(join(root, 'src/renderer/src/components/dashboard/ProviderStatusCard.tsx'), 'utf8')
  assert.doesNotMatch(card, /quotaUsed|quotaTotal/,
    'the dead quota fields must not come back without a producer')
})

test('五个状态没有共用同一句中文', () => {
  const zh = locales.find(l => l.name === 'zh-CN').aggregate
  const texts = STATES.map(state => zh.quota[state])
  assert.equal(new Set(texts).size, texts.length, `五态里出现了重复文案：${texts.join(' | ')}`)
})

test('账本的用量真的被塞进详情', () => {
  assert.match(page, /setQuotaUsage\(result\.quotaUsage \?\? \{\}\)/, 'the list result must feed the usage state')
  assert.match(page, /quotaUsage=\{quotaUsage\[selected\.id\]\}/, 'the detail reads its own entry usage')
  assert.match(detail, /const view = quotaViewOf\(entry, \{/, 'the quota view is computed per entry')
})

test('免费池标签与额度状态是两行，不合并', () => {
  assert.match(detail, /view\.isFreePool && \(/, 'the free-pool label is conditional on the catalogue flag')
  const badgeAt = detail.indexOf('aggregate.quotaFreePool')
  const stateAt = detail.indexOf('aggregate.quota.${view.state}')
  assert.ok(badgeAt > 0 && stateAt > badgeAt, 'both must render, in that order')
})
