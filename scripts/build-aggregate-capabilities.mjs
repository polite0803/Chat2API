/**
 * 生成聚合目录的**第三方能力**旁表（models.dev）。
 *
 * 与另外两张旁表的分工：
 * - `aggregateQuota.ts` —— 厂商官方额度/上下文（带 docUrl + asOf）；
 * - `aggregatePricing.ts` —— 第三方标价 + 官方免费清单（回答「要不要额外花钱」）；
 * - **本表** —— 第三方逐模型能力（tools / reasoning / 输入模态 / 上下文窗口），
 *   回答「这条模型的标注能不能自动补全」。
 *
 * 口径解释：
 * - 只有 `tool_call: true` / `reasoning: true` 才算证据；`false` 与缺失一律不写。
 *   models.dev 是社区维护的目录，`false` 更可能是「没填」而不是「确认不支持」，
 *   把没填当成不支持会让 `tools-capable` 策略误筛掉本来能用的模型。
 * - 只填 `vision`（由输入模态推出）与 `modalities` 一起写，消费方优先读 modalities。
 * - 只对齐 `baseUrl` 完全相同的 models.dev 供应商；一个 baseUrl 对上多家则跳过。
 * - 只保留本目录真正在服务的模型 id —— 给一个发不出去的模型打标注是噪声。
 *
 * 运行：
 * - 默认：读已提交快照 `docs/data/models-dev-capabilities.json` -> TS；
 * - `--payload <api.json>`：从 models.dev 原始 payload 重建快照 -> TS。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const REGISTRY = 'src/main/providers/aggregate/registry.ts'
const SNAPSHOT = 'docs/data/models-dev-capabilities.json'
const OUTPUT = 'src/shared/aggregateCapabilities.ts'
const MODELS_DEV_URL = 'https://models.dev/api.json'

const INPUT_MODALITIES = new Set(['text', 'image', 'audio', 'video', 'pdf'])

/** 纯字面量数组求值；非字面量会立刻抛错，而不是悄悄少读几家。 */
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

function capabilityOf(model) {
  if (!model || typeof model !== 'object') return null
  const hint = {}

  if (model.tool_call === true) hint.tools = 'yes'
  if (model.reasoning === true) hint.reasoning = 'yes'

  const inputs = Array.isArray(model.modalities?.input) ? model.modalities.input : []
  const modalities = [...new Set(inputs.filter(value => typeof value === 'string' && INPUT_MODALITIES.has(value)))]
  if (modalities.length > 0) {
    hint.modalities = modalities
    // `vision` 是 modalities 的派生结论，单独存一份，方便只读三态能力的消费方。
    if (modalities.includes('image')) hint.vision = 'yes'
  }

  const context = model.limit?.context
  if (Number.isInteger(context) && context > 0) hint.contextTokens = context

  return Object.keys(hint).length === 0 ? null : hint
}

function buildEntries(payload, registry) {
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
    if (candidates.length !== 1) {
      if (candidates.length > 1) skipped.push(`${entry.id}:${key} -> ${candidates.join(',')}`)
      continue
    }
    const provider = payload[candidates[0]]
    const models = {}
    for (const model of entry.models ?? []) {
      const hint = capabilityOf(provider?.models?.[model.id])
      if (hint) models[model.id] = hint
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
  return { entries, skipped }
}

function refreshSnapshot(payloadPath) {
  const payload = JSON.parse(readFileSync(payloadPath, 'utf-8'))
  const registry = readRegistry()
  const { entries, skipped } = buildEntries(payload, registry)

  const snapshot = {
    source: 'models.dev',
    url: MODELS_DEV_URL,
    asOf: new Date().toISOString().slice(0, 10),
    note: '第三方社区目录的逐模型能力声明；只采 true（tools/reasoning）与显式输入模态/上下文。不是厂商口径。',
    entries,
  }
  writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf-8')
  console.log(`已重建 ${SNAPSHOT}：${entries.length} 家有能力标注，${skipped.length} 家 baseUrl 对上多个供应商已跳过`)
  for (const line of skipped) console.log(`  跳过 ${line}`)
  return snapshot
}

function loadSnapshot() {
  return JSON.parse(readFileSync(SNAPSHOT, 'utf-8'))
}

function renderTs(snapshot) {
  const entries = [...(snapshot.entries ?? [])].sort((a, b) => a.entryId.localeCompare(b.entryId))
  const body = entries
    .map(entry => {
      const rows = Object.entries(entry.models)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([modelId, hint]) => {
          const parts = []
          if (hint.tools) parts.push(`tools: '${hint.tools}'`)
          if (hint.reasoning) parts.push(`reasoning: '${hint.reasoning}'`)
          if (hint.vision) parts.push(`vision: '${hint.vision}'`)
          if (Array.isArray(hint.modalities)) {
            parts.push(`modalities: [${hint.modalities.map(value => `'${value}'`).join(', ')}]`)
          }
          if (typeof hint.contextTokens === 'number') parts.push(`contextTokens: ${hint.contextTokens}`)
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

  const modelCount = entries.reduce((sum, entry) => sum + Object.keys(entry.models).length, 0)
  const toolCount = entries.reduce(
    (sum, entry) => sum + Object.values(entry.models).filter(hint => hint.tools === 'yes').length,
    0
  )
  const reasoningCount = entries.reduce(
    (sum, entry) => sum + Object.values(entry.models).filter(hint => hint.reasoning === 'yes').length,
    0
  )
  const modalityCount = entries.reduce(
    (sum, entry) => sum + Object.values(entry.models).filter(hint => Array.isArray(hint.modalities)).length,
    0
  )
  const contextCount = entries.reduce(
    (sum, entry) => sum + Object.values(entry.models).filter(hint => typeof hint.contextTokens === 'number').length,
    0
  )

  return `/**
 * 聚合目录的**第三方能力**旁表 —— 由 scripts/build-aggregate-capabilities.mjs 生成，请勿手改。
 * 要更新就带 --payload 抓一次 models.dev 的 api.json 重建快照，再重新生成。
 *
 * 只回答一件事：这条模型的 tools / reasoning / 输入模态 / 上下文窗口，第三方是否
 * 有声明。它是能力解析里**最低**的一层自动证据（排在厂商官方、供应商同步、静态表
 * 之后），只填前面都没说的字段，永远不覆盖已有标注；用户的手工标注又在它之上。
 *
 * 口径：只有 \`tool_call: true\` / \`reasoning: true\` 才算证据，\`false\` 与缺失一律
 * 不写 —— 社区目录里的 false 更可能是「没填」，把它当「不支持」会误筛。
 *
 * 快照：${snapshot.source ?? 'models.dev'} ${snapshot.url ?? MODELS_DEV_URL}，复核日期 ${snapshot.asOf ?? '未知'}；
 * ${entries.length} 家 / ${modelCount} 条模型：tools ${toolCount}、reasoning ${reasoningCount}、
 * 输入模态 ${modalityCount}、上下文窗口 ${contextCount}。
 */

import type { ModelCapabilityHint } from './types.ts'

export interface AggregateCapabilityRow {
  /** 对齐到的 models.dev 供应商 id（与本目录的 entryId 常常不同名） */
  modelsDevProviderId: string
  models: Record<string, ModelCapabilityHint>
}

export const AGGREGATE_CAPABILITIES: Record<string, AggregateCapabilityRow> = {
${body}
}

/**
 * 聚合条目的第三方能力标注。查不到就是查不到 —— 返回 \`undefined\`，不返回空对象：
 * 空对象在解释「这条为什么被筛掉」时会被当成「有第三方证据但什么都没说」。
 */
export function aggregateThirdPartyHint(
  entryId: string,
  modelId: string
): ModelCapabilityHint | undefined {
  return AGGREGATE_CAPABILITIES[entryId]?.models[modelId]
}
`
}

const payloadFlag = process.argv.indexOf('--payload')
const snapshot = payloadFlag >= 0
  ? refreshSnapshot(process.argv[payloadFlag + 1])
  : loadSnapshot()

writeFileSync(OUTPUT, renderTs(snapshot), 'utf-8')
const entries = snapshot.entries ?? []
const models = entries.reduce((sum, entry) => sum + Object.keys(entry.models).length, 0)
console.log(`已生成 ${OUTPUT}：${entries.length} 家 / ${models} 条模型有第三方能力标注`)
