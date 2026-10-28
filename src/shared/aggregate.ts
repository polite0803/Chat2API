/**
 * Types for the aggregated provider catalogue.
 *
 * The catalogue holds only standard, key-based (or key-less) HTTP endpoints.
 * Browser-login account channels and the responses-only relays are not listed:
 * their availability depends on other people's accounts or on a gate this app
 * cannot satisfy, which is exactly the class of integration that was retired.
 */

export type AggregateCategory = 'apikey' | 'free-tier' | 'local'

/** Wire protocol of an aggregate endpoint. Responses is not supported. */
export type AggregateWire = 'openai-chat' | 'anthropic-messages'

/**
 * How an endpoint is authenticated.
 * - apiKey: the user supplies a key, sent in the provider's auth header
 * - none: anonymous (local runtimes, free pools)
 * - unsupported: auth cannot be produced here (ADC / OAuth); the row is visible
 *   so the list is faithful, but it cannot be saved
 */
export type AggregateAuthKind = 'apiKey' | 'none' | 'unsupported'

export interface AggregateModelEntry {
  id: string
  name: string
}

export interface AggregateEntry {
  id: string
  name: string
  category: AggregateCategory
  authKind: AggregateAuthKind
  /** Where the user obtains the key */
  authUrl?: string
  /** Environment variable the upstream registry uses for the key */
  envVar?: string
  /** Default endpoint; null means the user has to supply one */
  baseUrl: string | null
  /** Documents which baseUrl variable the user may override */
  baseUrlOverrideEnv?: string
  wire: AggregateWire
  models: AggregateModelEntry[]
  /** Endpoint that lists models; absent means discovery is unavailable */
  modelsUrl?: string
  headers?: Record<string, string>
  notes?: string
  website?: string
  /** Ids the upstream project marks as free on a shared pool */
  freeModelsHint?: string[]
}

/** Per-entry state merged from the stored provider record, for the catalogue UI. */
export interface AggregateEntryState {
  configured: boolean
  enabled: boolean
  hasApiKey: boolean
  baseUrl: string | null
  modelCount: number
}

export interface AggregateListResult {
  entries: AggregateEntry[]
  states: Record<string, AggregateEntryState>
}

export interface AggregateSaveInput {
  id: string
  /** New key; omitted keeps the stored one */
  apiKey?: string
  /** Overrides the registry baseUrl (required when the registry has none or a placeholder) */
  baseUrl?: string
  /** Overrides which registry model ids are exposed, as raw upstream ids */
  models?: string[]
  enabled?: boolean
}

export interface AggregateOperationResult {
  success: boolean
  reason?: string
  detail?: string
  modelCount?: number
}
