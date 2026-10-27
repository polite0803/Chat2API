/**
 * OpenCode 供应商配置
 *
 * 凭据字段是空的：免费池不需要 key（隔离运行时 + 无凭据即可用，实测回 PONG）。
 * 请求不走 HTTP，而是由 `forwardOpencode` 驱动本机 OpenCode 运行时，所以这里的
 * apiEndpoint / chatPath 只是让供应商记录保持完整，不会被真正发起。
 *
 * supportedModels 是"当前无凭据运行时暴露的零计费模型"的快照（2026-10-27 实测 9 个，全部计费为 0，
 * 其中 big-pickle 名字里没有 free）。上游会变，用户可以在模型页自己增删。
 */
import type { BuiltinProviderConfig } from '../../store/types'

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
  supportedModels: [
    'glm-5.3-flash-free',
    'deepseek-v4.1-flash-free',
    'big-pickle',
    'mimo-v2.6-flash-free',
    'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free',
    'nemotron-3.5-super-vl-free',
    'beam-free',
    'flint-40b-free',
  ],
  modelMappings: {
    'glm-5.3-flash-free': 'glm-5.3-flash-free',
    'deepseek-v4.1-flash-free': 'deepseek-v4.1-flash-free',
    'big-pickle': 'big-pickle',
    'mimo-v2.6-flash-free': 'mimo-v2.6-flash-free',
    'nemotron-3-ultra-free': 'nemotron-3-ultra-free',
    'nemotron-3.5-lightning-free': 'nemotron-3.5-lightning-free',
    'nemotron-3.5-super-vl-free': 'nemotron-3.5-super-vl-free',
    'beam-free': 'beam-free',
    'flint-40b-free': 'flint-40b-free',
  },
  credentialFields: [],
}

export default opencodeConfig
