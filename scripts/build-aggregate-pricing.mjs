/**
 * 生成聚合目录的**消耗信号**旁表：第三方标价 + 官方免费模型清单。
 *
 * 与 `build-aggregate-quota.mjs` 的分工必须分清，否则三套数会打架：
 * - 额度旁表（`aggregateQuota.ts`）只收**厂商官方**公布的限额（RPM/TPM/…），带 docUrl + asOf；
 * - 本表只收两类**逐模型**信号：models.dev 的美元标价（第三方）与取证回执里
 *   官方点名免费的模型 id（官方口径，但只有"是/否"这一个比特）。
 *
 * ⚠️ 为什么单开一张表：额度表的数字能追到厂商文档页，models.dev 的价格追不到厂商；
 * 混在一处，读者没法判断某个数字是不是官方口径。
 *
 * ⚠️ 为什么标价不能当倍率：倍率是"相对基准消耗"（`x4.0`），标价是绝对美元。把 USD
 * 折成倍率需要一个基准，而本仓任何地方都没有这个基准。所以消费方只从价格里读
 * 「零价 / 非零价」，绝不排序、绝不换算。
 *
 * ⚠️ 为什么零价还要分两类：订阅制端点（zai 的 coding-plan、Kimi Code、千问/小米
 * Token Plan…）在 models.dev 上的边际价就是 0，因为额度已经买断在订阅里了 ——
 * 那是"含在套餐里"，不是"免费"。把它标成免费会让人以为可以不花钱无限用。
 * 判定依据不放正则，而是手写清单 `AGGREGATE_PLAN_ENTRIES`，每条带理由。
 *
 * 两种运行模式：
 * - 默认（离线、可重复）：读已提交快照 `docs/data/models-dev-cost.json` -> TS；
 * - `--payload <api.json>`：从 models.dev 原始 `api.json` 重建快照（需联网抓一次）-> TS。
 *
 * 一条硬规则：条目与 models.dev 供应商的对齐只认**完全相同的 baseUrl**
 * （host + 路径，忽略结尾斜杠）。按品牌名或按 host 猜，会把订阅制端点与按量端点
 * 混成一个，同一批模型 id 得到两种互相矛盾的价格。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'

const REGISTRY = 'src/main/providers/aggregate/registry.ts'
const RECEIPTS = 'docs/data/free-quota-research'
const SNAPSHOT = 'docs/data/models-dev-cost.json'
const OUTPUT = 'src/shared/aggregatePricing.ts'
const MODELS_DEV_URL = 'https://models.dev/api.json'

/** 纯字面量数组求值；一旦有人写入非字面量会在这里抛错，而不是悄悄少读几家。 */
function readRegistry() {
  const lines = readFileSync(REGISTRY, 'utf-8').split('\n')
  const start = lines.findIndex(line => line.startsWith('export const AGGREGATE_REGISTRY'))
  if (start < 0) throw new Error(`${REGISTRY}: 找不到 AGGREGATE_REGISTRY`)
  let end = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === ']') {
      end = i
      break
    }
  }
  if (end < 0) throw new Error(`${REGISTRY}: 找不到数组结尾`)
  const literal = lines.slice(start, end + 1).join('\n')
  const value = Function(`"use strict"; return (${literal.slice(literal.indexOf('= ') + 2)})`)()
  if (!Array.isArray(value)) throw new Error(`${REGISTRY}: 数组求值失败`)
  return value
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return null
  }
}

function priceOf(model) {
  const cost = model?.cost
  if (!cost || typeof cost !== 'object') return null
  if (typeof cost.input !== 'number' || typeof cost.output !== 'number') return null
  const row = { input: cost.input, output: cost.output }
  if (typeof cost.cache_read === 'number') row.cacheRead = cost.cache_read
  if (typeof cost.cache_write === 'number') row.cacheWrite = cost.cache_write
  return row
}

/** 从 models.dev 原始 payload 重建快照：只保留本目录真正暴露的模型 id。 */
function refreshSnapshot(payloadPath) {
  const payload = JSON.parse(readFileSync(payloadPath, 'utf-8'))
  const registry = readRegistry()

  const byBaseUrl = new Map()
  for (const [providerId, provider] of Object.entries(payload)) {
    const key = normalizeBaseUrl(provider?.api)
    if (!key) continue
    if (!byBaseUrl.has(key)) byBaseUrl.set(key, [])
    byBaseUrl.get(key).push(providerId)
  }

  const entries = []
  const skipped = []
  for (const entry of registry) {
    const key = normalizeBaseUrl(entry.baseUrl)
    if (!key) continue
    const candidates = byBaseUrl.get(key) ?? []
    // 一个 baseUrl 对上多个 models.dev 供应商 = 说不清是哪份价，宁缺毋录。
    if (candidates.length !== 1) {
      if (candidates.length > 1) skipped.push(`${entry.id}:${key} -> ${candidates.join(',')}`)
      continue
    }
    const provider = payload[candidates[0]]
    const models = {}
    for (const model of entry.models ?? []) {
      const price = priceOf(provider?.models?.[model.id])
      if (price) models[model.id] = price
    }
    if (Object.keys(models).length === 0) continue
    entries.push({
      entryId: entry.id,
      modelsDevProviderId: candidates[0],
      baseUrl: entry.baseUrl,
      models,
    })
  }

  entries.sort((a, b) => a.entryId.localeCompare(b.entryId))
  const snapshot = {
    source: 'models.dev',
    url: MODELS_DEV_URL,
    asOf: new Date().toISOString().slice(0, 10),
    currency: 'USD',
    unit: 'per-million-tokens',
    note: '第三方聚合清单的逐模型标价；不是厂商倍率、不是厂商官方口径。对齐只认完全相同的 baseUrl。',
    entries,
  }
  writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  console.log(`已重建 ${SNAPSHOT}：${entries.length} 家有标价，${skipped.length} 家 baseUrl 对上多个供应商已跳过`)
  for (const line of skipped) console.log(`  跳过 ${line}`)
  return snapshot
}

function loadSnapshot() {
  if (!existsSync(SNAPSHOT)) throw new Error(`缺少 ${SNAPSHOT}，先跑 --payload <api.json> 抓一次`)
  return JSON.parse(readFileSync(SNAPSHOT, 'utf-8'))
}

/**
 * 取证回执里的官方免费模型清单。
 *
 * 回执早就采了 `freeModelIds`（带出处页），但额度生成器只读数字字段，于是这份证据
 * 一直没进代码。这里把它接出来，并且**只保留本目录真的在服务的 id**：
 * 回执是按厂商页面抄的，页面上的免费模型不一定在我们目录里（cloudflare 13 条、
 * opencode_zen 5 条是命中的，其他家常有对不上的），claim 一个目录里不存在的 id
 * 等于给一个发不出去的模型打免费标。
 */
function readOfficialFree(registry) {
  const rows = []
  for (const name of readdirSync(RECEIPTS).filter(file => file.endsWith('.json')).sort()) {
    const parsed = JSON.parse(readFileSync(`${RECEIPTS}/${name}`, 'utf-8'))
    for (const row of Array.isArray(parsed) ? parsed : parsed.entries ?? []) {
      if (row.withdrawn || !row.entryId) continue
      const declared = Array.isArray(row.freeModelIds) ? row.freeModelIds : []
      if (declared.length === 0) continue

      const entry = registry.find(item => item.id === row.entryId)
      if (!entry) continue
      const shipped = new Set((entry.models ?? []).map(model => model.id))
      const models = [...new Set(declared.filter(id => shipped.has(id)))]
      const dropped = declared.length - models.length

      rows.push({
        entryId: row.entryId,
        models,
        dropped,
        docUrl: typeof row.docUrl === 'string' && row.docUrl.startsWith('https://') ? row.docUrl : '',
        asOf: typeof row.asOf === 'string' && row.asOf ? row.asOf : '2026-10-29',
      })
    }
  }
  return rows.filter(row => row.models.length > 0).sort((a, b) => a.entryId.localeCompare(b.entryId))
}

function num(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)))
}

function renderTs(snapshot, officialFree) {
  const entries = [...(snapshot.entries ?? [])].sort((a, b) => a.entryId.localeCompare(b.entryId))
  const priceBody = entries
    .map(entry => {
      const rows = Object.entries(entry.models)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([modelId, price]) => {
          const parts = [`input: ${num(price.input)}`, `output: ${num(price.output)}`]
          if (typeof price.cacheRead === 'number') parts.push(`cacheRead: ${num(price.cacheRead)}`)
          if (typeof price.cacheWrite === 'number') parts.push(`cacheWrite: ${num(price.cacheWrite)}`)
          return `      '${modelId.replace(/'/g, "\\'")}': { ${parts.join(', ')} },`
        })
        .join('\n')
      return [
        `  '${entry.entryId}': {`,
        `    modelsDevProviderId: '${entry.modelsDevProviderId}',`,
        '    models: {',
        rows,
        '    },',
        '  },',
      ].join('\n')
    })
    .join('\n')

  const freeBody = officialFree
    .map(row => {
      const ids = row.models.map(id => `'${id.replace(/'/g, "\\'")}'`).join(', ')
      return [
        `  '${row.entryId}': {`,
        `    models: [${ids}],`,
        `    docUrl: '${row.docUrl}',`,
        `    asOf: '${row.asOf}',`,
        '  },',
      ].join('\n')
    })
    .join('\n')

  const priced = entries.reduce((sum, entry) => sum + Object.keys(entry.models).length, 0)
  const zeros = entries.reduce(
    (sum, entry) => sum + Object.values(entry.models).filter(price => price.input === 0 && price.output === 0).length,
    0
  )
  const freeIds = officialFree.reduce((sum, row) => sum + row.models.length, 0)
  const droppedIds = officialFree.reduce((sum, row) => sum + row.dropped, 0)

  return `/**
 * 聚合目录的**逐模型消耗信号**旁表 —— 由 scripts/build-aggregate-pricing.mjs 生成，请勿手改。
 * 要更新就带 --payload 抓一次 models.dev 的 api.json 重建快照，再重新生成。
 *
 * 两套信号，口径完全不同，消费方（\`shared/aggregateCost.ts\`）必须分开读：
 *
 * 1. \`AGGREGATE_PRICE\` —— models.dev 的**第三方**按 token 美元标价（USD / 1M）。
 *    只用来回答"这条有标价 / 这条零价"，不排序、不换算、不当倍率。
 * 2. \`AGGREGATE_OFFICIAL_FREE\` —— 取证回执里**官方页面点名免费**的模型 id
 *    （带 docUrl + asOf）。这是官方口径，但只有"是/否"，没有数字。
 *
 * ⚠️ 零价 ≠ 免费。订阅制端点（\`AGGREGATE_PLAN_ENTRIES\` 里那几家）在 models.dev
 * 上的边际价就是 0，因为额度已买断在套餐里；把它当免费会让人以为能不花钱无限用。
 * 这个区分必须由 \`aggregateCostOf()\` 做，不要在界面里自己判价格。
 *
 * 快照：${snapshot.source ?? 'models.dev'} ${snapshot.url ?? MODELS_DEV_URL}
 * 复核日期 ${snapshot.asOf ?? '未知'}；${entries.length} 家有标价 / ${priced} 条模型，
 * 其中 ${zeros} 条零价。官方免费清单：${officialFree.length} 家 / ${freeIds} 条
 * （回执里另有 ${droppedIds} 条不在本目录模型清单内，已丢弃，不给发不出去的模型打标）。
 */

export interface AggregateModelPrice {
  /** 输入侧单价，USD / 1M tokens */
  input: number
  /** 输出侧单价，USD / 1M tokens */
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export interface AggregateEntryPrice {
  /** 对齐到的 models.dev 供应商 id（与本目录的 entryId 常常不同名） */
  modelsDevProviderId: string
  models: Record<string, AggregateModelPrice>
}

export interface AggregateOfficialFree {
  models: string[]
  /** 官方页面 URL；空串表示回执没给出可复核的出处 */
  docUrl: string
  asOf: string
}

export const AGGREGATE_PRICE_SOURCE = {
  name: '${snapshot.source ?? 'models.dev'}',
  url: '${snapshot.url ?? MODELS_DEV_URL}',
  asOf: '${snapshot.asOf ?? ''}',
  currency: 'USD',
  unit: 'per-million-tokens',
} as const

export const AGGREGATE_PRICE: Record<string, AggregateEntryPrice> = {
${priceBody}
}

export const AGGREGATE_OFFICIAL_FREE: Record<string, AggregateOfficialFree> = {
${freeBody}
}

export function aggregatePriceOf(entryId: string, modelId: string): AggregateModelPrice | undefined {
  return AGGREGATE_PRICE[entryId]?.models?.[modelId]
}

export function isZeroPrice(price: AggregateModelPrice | undefined): boolean {
  return price !== undefined && price.input === 0 && price.output === 0
}

export function officialFreeEvidenceOf(entryId: string, modelId: string): AggregateOfficialFree | undefined {
  const row = AGGREGATE_OFFICIAL_FREE[entryId]
  return row !== undefined && row.models.includes(modelId) ? row : undefined
}
`
}

const payloadFlag = process.argv.indexOf('--payload')
if (payloadFlag >= 0) {
  const path = process.argv[payloadFlag + 1]
  if (!path) throw new Error('--payload 需要一个 api.json 路径')
  refreshSnapshot(path)
}

const registry = readRegistry()
const snapshot = loadSnapshot()
const officialFree = readOfficialFree(registry)
writeFileSync(OUTPUT, renderTs(snapshot, officialFree), 'utf-8')

const entries = snapshot.entries ?? []
const models = entries.reduce((sum, entry) => sum + Object.keys(entry.models).length, 0)
const zeros = entries.reduce(
  (sum, entry) => sum + Object.values(entry.models).filter(price => price.input === 0 && price.output === 0).length,
  0
)
const freeIds = officialFree.reduce((sum, row) => sum + row.models.length, 0)
console.log(
  `已生成 ${OUTPUT}：${entries.length} 家有标价 / ${models} 条模型（${zeros} 条零价）；` +
    `官方免费 ${officialFree.length} 家 / ${freeIds} 条`
)
