import type { CatalogueModel, ProviderModelOverrides } from './types.ts'

/**
 * The single merge of a provider's model catalogue: shipped names, hand-added
 * models and the last online sync, each row carrying whether it is served now.
 * `getEffectiveModels()` is this filtered to the served rows, so the proxy, the
 * model list and the provider card can never disagree about what is exposed.
 */
export function buildModelCatalogue(
  supportedModels: string[],
  modelMappings: Record<string, string>,
  overrides: Pick<ProviderModelOverrides, 'addedModels' | 'excludedModels' | 'fetchedModels'>
): CatalogueModel[] {
  const excluded = new Set(overrides.excludedModels || [])
  const catalogue: CatalogueModel[] = (supportedModels || []).map(displayName => ({
    displayName,
    actualModelId: modelMappings[displayName] || displayName,
    isCustom: false,
    source: 'builtin' as const,
    served: !excluded.has(displayName),
  }))

  for (const model of overrides.addedModels || []) {
    catalogue.push({
      displayName: model.displayName,
      actualModelId: model.actualModelId,
      isCustom: true,
      source: 'custom',
      served: !excluded.has(model.displayName),
    })
  }

  // A synced name the user already sees from the shipped list or added by hand is never duplicated.
  const known = new Set(catalogue.map(model => model.displayName))
  for (const model of overrides.fetchedModels || []) {
    if (known.has(model.displayName)) continue
    known.add(model.displayName)
    catalogue.push({
      displayName: model.displayName,
      actualModelId: model.actualModelId,
      isCustom: false,
      source: 'fetched',
      served: !excluded.has(model.displayName),
    })
  }

  return catalogue
}

/** 目录名匹配：大小写无关，结尾的 `*` 是前缀通配 */
export function matchesCatalogueName(modelName: string, pattern: string): boolean {
  const normalizedModel = modelName.toLowerCase()
  const normalizedPattern = pattern.toLowerCase()
  if (normalizedPattern.endsWith('*')) {
    return normalizedModel.startsWith(normalizedPattern.slice(0, -1))
  }
  return normalizedPattern === normalizedModel
}

export interface RoutableInput {
  /** 请求里的模型名 */
  model: string
  /** 该家当前在服务的目录名；已停用的不在里面 */
  servedNames: string[]
  /** 该家是否有目录。没有目录才是通配供应商 */
  hasCatalogue: boolean
  /** 全局映射表里这个名字的记录 */
  mapping?: { actualModel: string; preferredProviderId?: string }
}

/**
 * 一家供应商能不能接某个模型名。在服务的目录是唯一权威：
 * 带 `preferredProviderId` 的映射只是那家的内部账本（聚合与账号通道按模型写），
 * 用它翻案会把刚停用的模型救回来照样发给上游。
 */
export function isModelRoutable({ model, servedNames, hasCatalogue, mapping }: RoutableInput): boolean {
  if (!hasCatalogue) return true
  if (servedNames.some(name => matchesCatalogueName(model, name))) return true
  if (!mapping) return false
  if (mapping.preferredProviderId) return false
  return servedNames.some(name => matchesCatalogueName(mapping.actualModel, name))
}

/**
 * The keys of the global mapping table that no provider catalogue claims - the
 * user's own aliases. The aggregate and channel syncs write one mapping per
 * model, so advertising every key would re-expose exactly the models the user
 * just stopped.
 */
export function aliasMappingKeys(
  mappings: Record<string, unknown>,
  catalogueNames: Set<string>
): string[] {
  return Object.keys(mappings || {}).filter(name => !catalogueNames.has(name))
}

/**
 * 查某个对外的模型名能声明多大的上下文窗口。
 *
 * 数据源是 `Provider.modelCapabilities`（内建同步与账号通道同步各自写入），所以
 * 「有没有」就等于「上游有没有说」：没有就说没有，返回 `undefined` 让调用方**省略
 * 这个键**。绝不能在这里放一个兜底数字 —— 虚报上界会让客户端把超长上下文直接发
 * 出去、被服务端拒（`trae-adapter.ts::contextWindowFor` 的注释记着同一个坑）。
 *
 * 匹配口径与路由一致：先按精确名，再按目录里的通配名（结尾 `*`）。
 *
 * ⚠️ 多个通配模式同时命中时取**最小**的那个窗口：宁可少报（客户端提前压缩，仍
 * 能用）也不可多报（请求被上游拒，用户看到的是硬失败）。
 */
export function contextWindowOf(
  capabilities: Record<string, { contextTokens?: number } | undefined> | undefined,
  name: string,
): number | undefined {
  if (capabilities === undefined || name.length === 0) return undefined
  const exact = capabilities[name]?.contextTokens
  if (typeof exact === 'number' && exact > 0) return exact

  const matched: number[] = []
  for (const [pattern, hint] of Object.entries(capabilities)) {
    if (hint === undefined || !matchesCatalogueName(name, pattern)) continue
    const value = hint.contextTokens
    if (typeof value === 'number' && value > 0) matched.push(value)
  }
  return matched.length > 0 ? Math.min(...matched) : undefined
}

/**
 * Stop or start `names` and return the new `excludedModels` without touching the
 * caller's array. Stopping is what keeps a model out of `/v1/models` and out of
 * the load balancer, so the same ledger drives advertising and routing.
 */
export function applyServed(excludedModels: string[], names: string[], served: boolean): string[] {
  if (served) {
    const targets = new Set(names)
    return (excludedModels || []).filter(name => !targets.has(name))
  }
  const next = new Set(excludedModels || [])
  for (const name of names) next.add(name)
  return [...next]
}

/**
 * 一次性改名：把一家供应商目录里的裸展示名搬进 `<prefix>/<id>` 命名空间。
 *
 * OpenCode 的模型此前以裸 id 对外（`deepseek-v4.1-flash-free`），现在与聚合条目、
 * 账号通道一样带 `opencode/` 前缀。启动同步会用随包配置重写供应商记录本身，但
 * `userModelOverrides` 里的旧数据不会自己改：旧同步写下的 fetchedModels 行还是裸名，
 * 不迁移的话目录会同时出现 `opencode/<id>`（随包快照）与裸 `<id>`（旧同步残留）两行，
 * 指向同一个上游模型。
 *
 * 规则（幂等：已经带前缀的名字原样保留）：
 * - fetchedModels：displayName 一律改写成 `prefix/<actualModelId>`（裸 id 是上游权威）；
 * - excludedModels：先按 fetchedModels 的旧名→新名对照表翻，翻不到的裸名直接加前缀——
 *   无论旧名是快照的裸 id 还是同步带回来的展示名，用户的停用状态都不丢；
 * - addedModels 是用户亲手加的，保持原样。
 */
export function namespaceModelOverrides(
  overrides: ProviderModelOverrides,
  prefix: string
): { next: ProviderModelOverrides; changed: boolean } {
  const prefixed = (modelId: string): string => `${prefix}/${modelId}`
  const renames = new Map<string, string>()
  let changed = false

  const fetchedModels = (overrides.fetchedModels || []).map(model => {
    if (model.displayName.includes('/')) return model
    const displayName = prefixed(model.actualModelId || model.displayName)
    if (displayName !== model.displayName) changed = true
    renames.set(model.displayName, displayName)
    return { ...model, displayName }
  })

  const excludedModels = (overrides.excludedModels || []).map(name => {
    const renamed = renames.get(name) ?? (name.includes('/') ? name : prefixed(name))
    if (renamed !== name) changed = true
    return renamed
  })

  return {
    next: changed ? { ...overrides, fetchedModels, excludedModels } : overrides,
    changed,
  }
}
