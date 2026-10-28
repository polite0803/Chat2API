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

/**
 * `data: [{ id, name?, isFree }]` - a gateway that lists paid and free models together.
 * Only the free slice is served without a credential, so every paid id is dropped here
 * rather than shipped as a row that would answer 401.
 */
function readOpenAiFreeList(payload: Payload): FetchedModel[] | null {
  const entries = asEntries(payload.data).filter(entry => entry.isFree === true)
  const models = toModels(entries, ['name', 'displayName'])
  return models.length > 0 ? models : null
}

const READERS: Record<Exclude<ModelsFetchReader, 'auto'>, (payload: Payload) => FetchedModel[] | null> = {
  'openai-list': readOpenAiList,
  'openai-free-list': readOpenAiFreeList,
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
