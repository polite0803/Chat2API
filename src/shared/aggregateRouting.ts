/**
 * 裸模型名 -> 跨供应商候选链。
 *
 * 背景：聚合目录里同一个模型名常出现在多家（实测 74 个名字出现在 ≥2 家），
 * 但请求里写裸名时，任何一家都不认领（目录名带 `<entry>/<model>` 前缀），于是直接 503。
 * 这里把"哪些家真的在服务这个名字"解析成一条有序链，交给调用方按额度余量逐个尝试。
 *
 * 两条硬规则：
 * - 写明了前缀（`glm/glm-5.2`）就不成链——用户点名了某一家，跨家切换会违背他的意图。
 * - 只认**精确同名**（大小写无关）。`deepseek/deepseek-v3.1:free` 这种带 vendor 段的 id 按全名匹配，
 *   不做"看起来像同一个"的模糊归并：那会把参数不同的模型混成一条链。
 *
 * 目录以参数传入，本模块不反向依赖 `src/main`。
 */

import type { AggregateEntry } from './aggregate'

export interface AggregateChainCandidate {
  entryId: string
  actualModelId: string
  /** 目录里的显示名，即 `<entryId>/<modelId>` */
  displayName: string
}

export interface ChainOptions {
  /** 该家的这个模型现在是否在服务（停用的不算候选） */
  isServed?: (entryId: string, modelId: string) => boolean
  /** 余量分 0..1，越高越先试；缺省视为同分，保持目录顺序 */
  headroom?: (entryId: string, modelId: string) => number
  /** 用户显式点过的那一家排到最前 */
  preferredEntryId?: string
}

export function resolveAggregateChain(
  entries: AggregateEntry[],
  requestedModel: string,
  options: ChainOptions = {}
): AggregateChainCandidate[] {
  const requested = requestedModel.trim().toLowerCase()
  if (!requested || requested.includes('/')) return []

  const isServed = options.isServed ?? (() => true)
  const headroom = options.headroom ?? (() => 0)

  const candidates: Array<AggregateChainCandidate & { rank: number; headroom: number }> = []
  for (const [index, entry] of entries.entries()) {
    for (const model of entry.models) {
      if (model.id.toLowerCase() !== requested) continue
      if (!isServed(entry.id, model.id)) continue
      candidates.push({
        entryId: entry.id,
        actualModelId: model.id,
        displayName: `${entry.id}/${model.id}`,
        rank: index,
        headroom: headroom(entry.id, model.id),
      })
    }
  }

  candidates.sort((a, b) => {
    const preferred = (candidate: typeof a): number =>
      options.preferredEntryId && candidate.entryId === options.preferredEntryId ? 0 : 1
    const byPreference = preferred(a) - preferred(b)
    if (byPreference !== 0) return byPreference
    if (b.headroom !== a.headroom) return b.headroom - a.headroom
    return a.rank - b.rank
  })

  return candidates.map(({ entryId, actualModelId, displayName }) => ({ entryId, actualModelId, displayName }))
}

/** 面板/诊断用：这个裸名一共能被几家接住。 */
export function chainCoverage(entries: AggregateEntry[], requestedModel: string): number {
  return resolveAggregateChain(entries, requestedModel).length
}
