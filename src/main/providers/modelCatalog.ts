/**
 * Provider Model Catalog
 * Fetches a provider's model list from its own site using the declarative
 * modelsFetch config on the built-in provider.
 */

import axios from 'axios'
import { randomUUID } from 'crypto'
import { getBuiltinProvider } from './builtin/index.ts'
import { opencodeDisplayName } from './builtin/opencode.ts'
import { resolveModelListSource } from './modelListSource.ts'
import { readModelList } from './modelListReaders'
import { buildAuthHeaders, buildRequestBody, buildRequestUrl } from './modelListRequest'
import { storeManager } from '../store/store'
import { opencodeService } from '../opencode/service.ts'
import type { ModelsFetchResult } from '../store/types'

const TIMEOUT_MS = 15000

export async function fetchProviderModels(providerId: string): Promise<ModelsFetchResult> {
  const config = getBuiltinProvider(providerId)
  const source = resolveModelListSource(config)

  if (!config || source === 'unsupported') {
    return {
      ok: false,
      reason: 'unsupported',
      detail: config
        ? `provider ${providerId} declares neither a runtime nor a modelsFetch source`
        : `provider ${providerId} is not a built-in provider`,
    }
  }

  // OpenCode 的清单在本机运行时里（它报什么就有什么），不走 HTTP
  if (source === 'runtime') {
    try {
      // 「更新模型」是用户主动要最新清单的时刻：启动运行时之前先刷一次目录
      const models = await opencodeService.models({ refreshCatalog: true })
      const free = models.filter(model => model.zeroCost)
      // 走 Anthropic 协议的那几个模型，我们的通路是 OpenAI 形状，发不通：不收，但要说明白
      const usable = free.filter(model => model.protocol === 'openai')
      const skipped = free.filter(model => model.protocol !== 'openai')
      if (usable.length === 0) {
        return {
          ok: false,
          reason: 'empty',
          detail: 'the local OpenCode runtime reported no zero-cost models on the OpenAI-compatible endpoint',
        }
      }
      return {
        ok: true,
        // 展示名是 `opencode/<运行时id>`（与静态快照、聚合条目、账号通道同一命名空间），
        // actualModelId 保持运行时认的裸 id——转发层拿到的就是它。
        models: usable.map(model => ({
          displayName: opencodeDisplayName(model.id),
          actualModelId: model.id,
        })),
        detail:
          skipped.length > 0
            ? `${skipped.length} model(s) are served over the Anthropic protocol and are not reachable here: ${skipped.map(m => m.id).join(', ')}`
            : undefined,
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'network_error',
        detail: error instanceof Error ? error.message : 'failed to reach the local OpenCode runtime',
      }
    }
  }

  const fetchConfig = config.modelsFetch

  if (!fetchConfig) {
    return {
      ok: false,
      reason: 'unsupported',
      detail: `provider ${providerId} declares no modelsFetch`,
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(config.headers || {}),
    ...(fetchConfig.headers || {}),
  }

  const authRules = fetchConfig.auth || []
  if (authRules.length > 0) {
    const activeAccount = storeManager
      .getAccountsByProviderId(config.id)
      .find(account => account.status === 'active')

    if (!activeAccount) {
      return { ok: false, reason: 'no_active_account' }
    }

    const built = buildAuthHeaders(authRules, activeAccount.credentials)
    if (!built.ok) {
      // Field names only; never the values
      return { ok: false, reason: 'missing_credential_field', detail: built.missingFields.join(', ') }
    }

    Object.assign(headers, built.headers)
  }

  const uuid = randomUUID()
  const url = buildRequestUrl(fetchConfig.url, uuid)
  const body = buildRequestBody(fetchConfig.body, uuid)
  const request = { headers, timeout: TIMEOUT_MS, validateStatus: () => true }

  try {
    const response =
      fetchConfig.method === 'POST'
        ? await axios.post(url, body, request)
        : await axios.get(url, request)

    if (response.status !== 200) {
      return { ok: false, reason: 'http_status', detail: `HTTP ${response.status}` }
    }

    return readModelList(response.data, fetchConfig.reader ?? 'auto')
  } catch (error) {
    return {
      ok: false,
      reason: 'network_error',
      detail: error instanceof Error ? error.message : 'request failed',
    }
  }
}
