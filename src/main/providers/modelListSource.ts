/**
 * 模型清单来源判定
 *
 * 一个供应商的清单有三种来路：本机运行时（OpenCode）、HTTP 端点（modelsFetch）、
 * 都没有。判定顺序不能反：本机运行时的供应商本来就没有 HTTP 端点，如果先查
 * modelsFetch，它会被误判成"不支持在线更新"。
 */

export type ModelListSource = 'runtime' | 'http' | 'unsupported'

export interface ModelListSourceConfig {
  runtimeModels?: boolean
  modelsFetch?: unknown
}

export function resolveModelListSource(
  config: ModelListSourceConfig | undefined | null
): ModelListSource {
  if (!config) return 'unsupported'
  if (config.runtimeModels) return 'runtime'
  if (config.modelsFetch) return 'http'
  return 'unsupported'
}
