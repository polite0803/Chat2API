/**
 * Model List Readers
 * Pure payload readers for the providers' model list responses, kept free of
 * electron and axios imports so they can be tested without booting the app.
 */

import type { FetchedModel, ModelsFetchReader, ModelsFetchResult } from '../../shared/types'

type Payload = Record<string, unknown>

function asRecord(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Payload)
    : null
}

function asEntries(value: unknown): Payload[] {
  if (!Array.isArray(value)) return []
  return value.map(asRecord).filter((entry): entry is Payload => entry !== null)
}

function text(entry: Payload, key: string): string | undefined {
  const value = entry[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function toModels(entries: Payload[], nameKeys: string[], idKeys: string[] = ['id', 'model']): FetchedModel[] {
  const models: FetchedModel[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const actualModelId = idKeys.map(key => text(entry, key)).find(Boolean)
    if (!actualModelId) continue
    const displayName = nameKeys.map(key => text(entry, key)).find(Boolean) ?? actualModelId
    // Gateways repeat one model across scenarios, so the first sighting wins
    if (seen.has(actualModelId)) continue
    seen.add(actualModelId)
    models.push({ displayName, actualModelId })
  }

  return models
}

/** `data: [{ id, name? }]` - the OpenAI-compatible shape */
function readOpenAiList(payload: Payload): FetchedModel[] | null {
  const models = toModels(asEntries(payload.data), ['name', 'displayName'])
  return models.length > 0 ? models : null
}

/** `data: { data: [{ id, name }] }` - what chat.qwen.ai wraps its list in */
function readQwenDoubleData(payload: Payload): FetchedModel[] | null {
  const inner = asRecord(payload.data)
  if (!inner) return null
  const models = toModels(asEntries(inner.data), ['name'])
  return models.length > 0 ? models : null
}

/** `availableModels: [{ id, name? }]` - what kimi's config gateway returns */
function readKimiAvailableModels(payload: Payload): FetchedModel[] | null {
  const models = toModels(asEntries(payload.availableModels), ['name', 'displayName'])
  return models.length > 0 ? models : null
}

/**
 * `data: [{ displayModelName, modelCode, show }]` - chat2-api.qianwen.com's envelope.
 * Entries carry no `id`, and hidden ones must stay hidden the way the site hides them.
 */
function readQwenCnModelList(payload: Payload): FetchedModel[] | null {
  const entries = asEntries(payload.data).filter(entry => entry.show !== false)
  const models: FetchedModel[] = []
  const seen = new Set<string>()

  for (const entry of entries) {
    const actualModelId = text(entry, 'modelCode')
    const displayName = text(entry, 'displayModelName')
    if (!actualModelId || !displayName) continue
    if (seen.has(actualModelId)) continue
    seen.add(actualModelId)
    models.push({ displayName, actualModelId })
  }

  return models.length > 0 ? models : null
}

/** `models: [{ model_id, display_name }]` - agent.minimax.cn's cloud config envelope */
function readMinimaxCloudConfig(payload: Payload): FetchedModel[] | null {
  const models = toModels(asEntries(payload.models), ['display_name'], ['model_id'])
  return models.length > 0 ? models : null
}

/**
 * `data.modelConfigList: [{ model, name, isInPromptNameList }]` - aistudio.xiaomimimo.com's bot config.
 * The list carries many internal entries whose `name` repeats across different `model` ids; only the
 * ones flagged `isInPromptNameList` are what the site actually offers, and filtering on that flag is
 * also what keeps two entries from landing on the same display name.
 */
function readMimoBotConfig(payload: Payload): FetchedModel[] | null {
  const inner = asRecord(payload.data)
  if (!inner) return null
  const entries = asEntries(inner.modelConfigList).filter(entry => entry.isInPromptNameList === true)
  const models = toModels(entries, ['name'], ['model'])
  return models.length > 0 ? models : null
}

const READERS: Record<Exclude<ModelsFetchReader, 'auto'>, (payload: Payload) => FetchedModel[] | null> = {
  'openai-list': readOpenAiList,
  'qwen-double-data': readQwenDoubleData,
  'kimi-available-models': readKimiAvailableModels,
  'qwen-cn-model-list': readQwenCnModelList,
  'minimax-cloud-config': readMinimaxCloudConfig,
  'mimo-bot-config': readMimoBotConfig,
}

/**
 * Read a payload with one reader, or with every reader in order when reader is 'auto'.
 * An unrecognised payload is reported as such instead of coming back as an empty list,
 * so a UI toast can never look like "this provider has no models".
 */
export function readModelList(
  data: unknown,
  reader: ModelsFetchReader = 'auto'
): ModelsFetchResult {
  const payload = asRecord(data)
  if (!payload) {
    return {
      ok: false,
      reason: 'unrecognized_shape',
      detail: `expected a JSON object, received ${data === null ? 'null' : typeof data}`,
    }
  }

  const candidates =
    reader === 'auto'
      ? (Object.keys(READERS) as Array<keyof typeof READERS>)
      : [reader]

  for (const key of candidates) {
    const models = READERS[key](payload)
    if (models && models.length > 0) return { ok: true, models }
  }

  return {
    ok: false,
    reason: reader === 'auto' ? 'unrecognized_shape' : 'empty',
    detail: `readers tried: ${candidates.join(', ')}; top-level keys: ${Object.keys(payload).join(', ') || '(none)'}`,
  }
}
