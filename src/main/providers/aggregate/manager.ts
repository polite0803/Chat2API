/**
 * Aggregate provider manager.
 *
 * The catalogue ships as data (see `registry.ts`); a provider record is only
 * created once the user saves a key or a key-less endpoint, keeping the
 * provider list free of 70+ unusable rows. Aggregate records are `type:
 * 'aggregate'`, which startup leaves untouched (it only repairs builtins) and
 * which the parameter policy passes through unchanged.
 */

import axios from 'axios'
import {
  AGGREGATE_REGISTRY,
  getAggregateEntry,
  aggregateAuthHeader,
  aggregateChatPath,
  aggregateModelName,
} from './registry'
import { readModelList } from '../modelListReaders'
import AccountManager from '../../store/accounts'
import { storeManager } from '../../store/store'
import type { Account, ModelMapping, Provider } from '../../store/types'
import type {
  AggregateEntry,
  AggregateEntryState,
  AggregateListResult,
  AggregateOperationResult,
  AggregateSaveInput,
} from '../../../shared/aggregate'

const PROBE_TIMEOUT_MS = 20000

function trimmed(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

function isUsableBaseUrl(baseUrl: string): boolean {
  if (!baseUrl) return false
  if (baseUrl.includes('{')) return false
  return /^https?:\/\//i.test(baseUrl)
}

class AggregateProviderManager {
  list(): AggregateListResult {
    const states: Record<string, AggregateEntryState> = {}
    for (const entry of AGGREGATE_REGISTRY) {
      states[entry.id] = this.getState(entry)
    }
    return { entries: AGGREGATE_REGISTRY, states }
  }

  getState(entry: AggregateEntry): AggregateEntryState {
    const provider = storeManager.getProviderById(entry.id)
    if (!provider || provider.type !== 'aggregate') {
      return {
        configured: false,
        enabled: false,
        hasApiKey: false,
        baseUrl: entry.baseUrl,
        modelCount: entry.models.length,
      }
    }

    return {
      configured: true,
      enabled: provider.enabled,
      hasApiKey: entry.authKind === 'apiKey'
        ? AccountManager.getByProviderId(entry.id, true).some(a => Boolean(a.credentials.apiKey))
        : false,
      baseUrl: provider.apiEndpoint,
      modelCount: provider.supportedModels?.length ?? 0,
    }
  }

  /**
   * Creates or updates the provider record for a catalogue entry and stores the
   * key. Throws on invalid input; the IPC layer turns the message into a UI
   * failure rather than a half-written record.
   */
  save(input: AggregateSaveInput): Provider {
    const entry = getAggregateEntry(input.id)
    if (!entry) throw new Error('unknown_entry')
    if (entry.authKind === 'unsupported') throw new Error('unsupported_auth')

    const baseUrl = trimmed(input.baseUrl ?? entry.baseUrl)
    if (!baseUrl) throw new Error('missing_base_url')
    if (baseUrl.includes('{')) throw new Error('placeholder_base_url')
    if (!isUsableBaseUrl(baseUrl)) throw new Error('invalid_base_url')

    const existing = storeManager.getProviderById(entry.id)
    const apiKey = input.apiKey?.trim()
    if (entry.authKind === 'apiKey' && !apiKey && !this.hasStoredKey(entry.id)) {
      throw new Error('missing_api_key')
    }

    const registryIds = new Set(entry.models.map(model => model.id))
    const rawModels = (input.models && input.models.length > 0 ? input.models : entry.models.map(model => model.id))
      .map(id => id.trim())
      .filter(id => id.length > 0)
    // When the catalogue has no list (endpoints that only support discovery),
    // accept whatever ids the user supplied; otherwise keep it inside the list.
    const models = registryIds.size > 0 ? rawModels.filter(id => registryIds.has(id)) : rawModels

    const supportedModels = models.map(id => aggregateModelName(entry.id, id))
    const modelMappings: Record<string, string> = {}
    models.forEach((id, index) => {
      modelMappings[supportedModels[index]] = id
    })

    const auth = aggregateAuthHeader(entry)
    const now = Date.now()
    const record: Provider = {
      id: entry.id,
      name: entry.name,
      type: 'aggregate',
      authType: 'token',
      apiEndpoint: baseUrl,
      chatPath: aggregateChatPath(entry),
      headers: {
        'Content-Type': 'application/json',
        ...(entry.headers || {}),
      },
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      description: entry.notes,
      supportedModels,
      modelMappings,
      credentialFields: entry.authKind === 'apiKey'
        ? [{
            name: 'apiKey',
            label: 'API Key',
            type: 'password',
            required: true,
            placeholder: entry.envVar || 'Enter API Key',
            helpText: entry.authUrl,
          }]
        : [],
      supportsModelFetch: Boolean(entry.modelsUrl),
      aggregateId: entry.id,
      wire: entry.wire,
      authHeader: auth.header,
      authPrefix: auth.prefix,
    }

    if (existing) {
      storeManager.updateProvider(entry.id, record)
    } else {
      storeManager.addProvider(record)
    }

    if (entry.authKind === 'none') {
      this.ensureLocalAccount(entry.id, entry.name)
    } else if (apiKey) {
      this.writeKey(entry.id, entry.name, apiKey)
      this.ensureLocalAccount(entry.id, entry.name)
    }

    this.writeMappings(entry.id, modelMappings)
    return storeManager.getProviderById(entry.id) ?? record
  }

  setEnabled(id: string, enabled: boolean): Provider {
    const provider = storeManager.getProviderById(id)
    if (!provider || provider.type !== 'aggregate') throw new Error('not_configured')
    const updated = storeManager.updateProvider(id, { enabled, updatedAt: Date.now() })
    if (!updated) throw new Error('not_configured')
    return updated
  }

  remove(id: string): void {
    const provider = storeManager.getProviderById(id)
    if (!provider || provider.type !== 'aggregate') return
    for (const account of AccountManager.getByProviderId(id, true)) {
      AccountManager.delete(account.id)
    }
    storeManager.deleteProvider(id)
    this.writeMappings(id, {})
  }

  /** Probes the catalogue's model list and reports what the endpoint answered. */
  async test(id: string): Promise<AggregateOperationResult> {
    const entry = getAggregateEntry(id)
    if (!entry) return { success: false, reason: 'unknown_entry' }
    const provider = storeManager.getProviderById(id)
    if (!provider || provider.type !== 'aggregate') {
      return { success: false, reason: 'not_configured' }
    }

    const probe = await this.probe(entry, provider)
    if (!probe.ok) return probe.result
    return { success: true, modelCount: probe.models.length }
  }

  /** Replaces the provider's exposed models with whatever the endpoint lists. */
  async discoverModels(id: string): Promise<AggregateOperationResult> {
    const entry = getAggregateEntry(id)
    if (!entry) return { success: false, reason: 'unknown_entry' }
    const provider = storeManager.getProviderById(id)
    if (!provider || provider.type !== 'aggregate') {
      return { success: false, reason: 'not_configured' }
    }

    const probe = await this.probe(entry, provider)
    if (!probe.ok) return probe.result

    const ids = probe.models.map(model => model.actualModelId)
    if (ids.length === 0) return { success: false, reason: 'empty' }
    try {
      this.save({ id, baseUrl: provider.apiEndpoint, models: ids, enabled: provider.enabled })
    } catch (error) {
      return { success: false, reason: 'save_failed', detail: error instanceof Error ? error.message : String(error) }
    }
    return { success: true, modelCount: ids.length }
  }

  private hasStoredKey(id: string): boolean {
    return AccountManager.getByProviderId(id, true).some(account => Boolean(account.credentials.apiKey))
  }

  /** Keeps exactly one keyed account, so the load balancer always finds one. */
  private writeKey(providerId: string, providerName: string, apiKey: string): void {
    const existing = AccountManager.getByProviderId(providerId, true)
    if (existing.length > 0) {
      AccountManager.update(existing[0].id, {
        credentials: { ...existing[0].credentials, apiKey },
        status: 'active',
      })
      return
    }
    AccountManager.create({
      providerId,
      name: `${providerName} key`,
      credentials: { apiKey },
    })
  }

  private ensureLocalAccount(providerId: string, providerName: string): void {
    const existing = AccountManager.getByProviderId(providerId, false)
    if (existing.length > 0) return
    AccountManager.create({
      providerId,
      name: `${providerName} (keyless)`,
      credentials: {},
    })
  }

  /**
   * Rewrites the global model mappings owned by this provider. Existing entries
   * under the same `preferredProviderId` that are not in the new set are
   * dropped, so removing or replacing a catalogue never leaves stale names.
   */
  private writeMappings(providerId: string, mappings: Record<string, string>): void {
    const config = storeManager.getConfig()
    const next: Record<string, ModelMapping> = {}
    for (const [requestModel, mapping] of Object.entries(config.modelMappings || {})) {
      if (mapping.preferredProviderId !== providerId) next[requestModel] = mapping
    }
    for (const [requestModel, actualModel] of Object.entries(mappings)) {
      next[requestModel] = { requestModel, actualModel, preferredProviderId: providerId }
    }
    storeManager.updateConfig({ modelMappings: next })
  }

  private buildProbeHeaders(entry: AggregateEntry, provider: Provider, account?: Account): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...provider.headers,
    }
    const key = account?.credentials.apiKey
    if (key) {
      const auth = aggregateAuthHeader(entry)
      headers[auth.header] = `${auth.prefix}${key}`
    }
    if (entry.wire === 'anthropic-messages') {
      headers['anthropic-version'] = provider.headers?.['anthropic-version'] || '2023-06-01'
    }
    return headers
  }

  private async probe(
    entry: AggregateEntry,
    provider: Provider,
  ): Promise<{ ok: true; models: { displayName: string; actualModelId: string }[] } | { ok: false; result: AggregateOperationResult }> {
    if (!entry.modelsUrl) {
      return { ok: false, result: { success: false, reason: 'no_model_list' } }
    }

    const url = /^https?:\/\//i.test(entry.modelsUrl)
      ? entry.modelsUrl
      : `${trimmed(provider.apiEndpoint)}${entry.modelsUrl.startsWith('/') ? '' : '/'}${entry.modelsUrl}`

    const account = entry.authKind === 'apiKey'
      ? AccountManager.getByProviderId(entry.id, true)[0]
      : undefined
    if (entry.authKind === 'apiKey' && !account?.credentials.apiKey) {
      return { ok: false, result: { success: false, reason: 'missing_api_key' } }
    }

    try {
      const response = await axios.get(url, {
        headers: this.buildProbeHeaders(entry, provider, account),
        timeout: PROBE_TIMEOUT_MS,
        validateStatus: () => true,
      })

      if (response.status >= 400) {
        return {
          ok: false,
          result: { success: false, reason: 'http_status', detail: `HTTP ${response.status}` },
        }
      }

      const reader = entry.id === 'kilo' ? 'openai-free-list' : 'auto'
      const parsed = readModelList(response.data, reader)
      if (!parsed.ok) {
        return { ok: false, result: { success: false, reason: parsed.reason } }
      }
      return { ok: true, models: parsed.models }
    } catch (error) {
      return {
        ok: false,
        result: {
          success: false,
          reason: 'network_error',
          detail: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }
}

export const aggregateProviderManager = new AggregateProviderManager()
