/**
 * OpenCode 供应商配置
 *
 * 凭据字段是空的：免费池不需要 key（隔离运行时 + 无凭据即可用，实测回 PONG）。
 * 请求不走 HTTP，而是由 `forwardOpencode` 驱动本机 OpenCode 运行时，所以这里的
 * apiEndpoint / chatPath 只是让供应商记录保持完整，不会被真正发起。
 *
 * 模型名带供应商前缀（`opencode/<运行时模型id>`，与聚合条目、账号通道同一命名空间）：
 * 展示名是客户端请求的名字，modelMappings 把它翻回运行时认的裸 id。带前缀还能把
 * 本机运行时和 `opencode_zen` 聚合条目里同名的免费模型（mimo/nemotron/big-pickle）分开——
 * 裸名会撞车，前缀是点名。
 *
 * supportedModels 是"当前无凭据运行时暴露的零计费模型"的快照（2026-10-27 实测 9 个，全部计费为 0，
 * 其中 big-pickle 名字里没有 free）。上游会变，用户可以在模型页自己增删。
 */
import type { BuiltinProviderConfig } from '../../store/types'

/** 运行时报告的零计费模型裸 id 快照（2026-10-27） */
const FREE_MODEL_IDS = [
  'glm-5.3-flash-free',
  'deepseek-v4.1-flash-free',
  'big-pickle',
  'mimo-v2.6-flash-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'nemotron-3.5-super-vl-free',
  'beam-free',
  'flint-40b-free',
]

/** OpenCode 模型的对外名字：`opencode/<运行时模型id>`。运行时清单同步走同一个函数 */
export function opencodeDisplayName(modelId: string): string {
  return `opencode/${modelId}`
}

export const opencodeConfig: BuiltinProviderConfig = {
  id: 'opencode',
  name: 'OpenCode',
  type: 'builtin',
  authType: 'userToken',
  apiEndpoint: 'opencode://local',
  chatPath: '/local',
  headers: {},
  enabled: true,
  description: 'OpenCode free model pool via a local OpenCode runtime (no credential needed, ~30-60s per reply)',
  // 清单来自本机 OpenCode 运行时（它报什么就有什么），不是 HTTP 端点
  runtimeModels: true,
  supportedModels: FREE_MODEL_IDS.map(opencodeDisplayName),
  modelMappings: Object.fromEntries(FREE_MODEL_IDS.map(id => [opencodeDisplayName(id), id])),
  credentialFields: [],
}

export default opencodeConfig
