import type { AggregateWire } from './aggregate'
import type { ChannelLoginKind } from './channels'

export type { AggregateWire }

export type AccountStatus = 'active' | 'inactive' | 'expired' | 'error'

export type ProviderStatus = 'online' | 'offline' | 'unknown'


export type ProviderType = 'builtin' | 'custom' | 'aggregate' | 'account'

// Provider vendor type (for OAuth adapters)
export type ProviderVendor = 'opencode' | 'custom'

/**
 * The web-page integrations that were retired in 1.5. Startup purges their
 * providers, accounts and model mappings from stored data, so this list is the
 * single place that names them.
 */
export const RETIRED_PROVIDER_IDS = [
  'deepseek',
  'glm',
  'kimi',
  'mimo',
  'minimax',
  'qwen',
  'qwen-ai',
  'zai',
] as const

export type RetiredProviderId = (typeof RETIRED_PROVIDER_IDS)[number]

export type AuthType = 
  | 'oauth' 
  | 'token' 
  | 'cookie' 
  | 'userToken' 
  | 'refresh_token' 
  | 'jwt' 
  | 'realUserID_token' 
  | 'tongyi_sso_ticket'

export interface CredentialField {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
  helpText?: string
}

/**
 * 选号策略。
 * - `round-robin` / `fill-first` / `failover`：只看账号池顺序与失败历史；
 * - `smart`：在可用候选里挑**最早解封**的那个，把快重置的额度先用掉；
 * - `pace`：挑"每小时剩余额度最多"的那个，把额度平摊到重置前。
 *
 * 后两者依赖额度账本（`shared/quotaPacing.ts` 推算重置时刻）。推不出来时它们
 * **不改可用性**，只是退回原有顺序 —— 没有上限的家不该因为"算不出来"被踢出候选。
 */
export type LoadBalanceStrategy = 'round-robin' | 'fill-first' | 'failover' | 'smart' | 'pace'

/** 三态能力：`unknown` 是真实状态，既不等于能用也不等于不能用 */
export type CapabilityState = 'yes' | 'no' | 'unknown'

export type AutoModelTier = 'fast' | 'balanced' | 'strong'

/**
 * One model's routing annotation, keyed by display name inside
 * `Provider.modelCapabilities`.
 *
 * Every field is optional and *absent means unknown* - never a default value.
 * `weight` / `free` come from the account-channel catalogue (the multiplier
 * that upstream prints in the display name); builtin and aggregate providers
 * leave them unset because neither publishes a per-model cost.
 */
export interface ModelCapabilityHint {
  tier?: AutoModelTier
  vision?: Exclude<CapabilityState, 'unknown'>
  tools?: Exclude<CapabilityState, 'unknown'>
  contextTokens?: number
  /** Credit multiplier reported by the channel pack; absent means unreported */
  weight?: number
  free?: boolean
}

/**
 * What the caller wants `auto` to optimise for. Overrides the target tier and
 * the weight the cost factor carries in scoring.
 */
export type AutoPreference = 'balanced' | 'fast' | 'strong' | 'cheap'

export const AUTO_PREFERENCES: readonly AutoPreference[] = ['balanced', 'fast', 'strong', 'cheap']

export interface AutoRoutingConfig {
  /** Enables the virtual `auto` model. When off, `auto` is hidden from /v1/models and rejected. */
  enabled: boolean
  /** Maximum number of candidates tried before giving up on one request. */
  maxAttempts: number
  /** How long a conversation stays pinned to the model it first succeeded on. 0 disables stickiness. */
  stickyMinutes: number
  /** Default optimisation target; `X-Auto-Prefer` overrides it per request. */
  prefer: AutoPreference
}

export const DEFAULT_AUTO_ROUTING_CONFIG: AutoRoutingConfig = {
  enabled: true,
  maxAttempts: 3,
  stickyMinutes: 30,
  prefer: 'balanced',
}

export type Theme = 'light' | 'dark' | 'system'

export type {
  LegacyToolPromptConfig,
  ToolCallingConfig,
} from './toolCalling'

import type {
  LegacyToolPromptConfig,
  ToolCallingConfig,
} from './toolCalling'

export interface Account {
  id: string
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  status: AccountStatus
  lastUsed?: number
  lastStatusCheck?: number
  createdAt: number
  updatedAt: number
  errorMessage?: string
  requestCount?: number
  dailyLimit?: number
  todayUsed?: number
}

export interface Provider {
  id: string
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers: Record<string, string>
  enabled: boolean
  createdAt: number
  updatedAt: number
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  credentialFields?: CredentialField[]
  /** Catalogue entry this record came from, for `type: 'aggregate'` records */
  aggregateId?: string
  /** Wire protocol of an aggregate endpoint; builtin/custom leave it unset */
  wire?: AggregateWire
  /** Header that carries the API key; defaults to Authorization */
  authHeader?: string
  /** Prefix placed before the key inside authHeader; defaults to "Bearer " */
  authPrefix?: string
  /** Set at startup from the shipped provider config: this provider has an online model list source */
  supportsModelFetch?: boolean
  /**
   * How the user proves ownership of this provider's accounts, for
   * `type: 'account'` records only.
   *
   * `authType` cannot express this: the enum has no browser/device-code member,
   * so a channel record stored `authType: 'token'` and the card rendered
   * "API Key" for a channel whose accounts are obtained by browser login. The
   * authoritative value lives in the channel catalogue (`loginKind`); this field
   * carries it across the IPC boundary because the renderer cannot import
   * `src/main/**` without dragging electron into the bundle.
   */
  loginKind?: ChannelLoginKind
  status?: ProviderStatus
  lastStatusCheck?: number
}

export interface ModelMapping {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ApiKey {
  id: string
  name: string
  key: string
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  usageCount: number
  description?: string
}

export interface AppConfig {
  proxyPort: number
  proxyHost: string
  loadBalanceStrategy: LoadBalanceStrategy
  modelMappings: Record<string, ModelMapping>
  theme: Theme
  autoStart: boolean
  autoStartProxy: boolean
  minimizeToTray: boolean
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays: number
  requestLogConfig: RequestLogConfig
  requestTimeout: number
  retryCount: number
  apiKeys: ApiKey[]
  enableApiKey: boolean
  oauthProxyMode: 'system' | 'none'
  sessionConfig: SessionConfig
  toolCallingConfig: ToolCallingConfig
  toolPromptConfig?: LegacyToolPromptConfig
  managementApi: ManagementApiConfig
  contextManagement?: unknown
  autoRouting: AutoRoutingConfig
  compression: CompressionConfig
  outputSteering: OutputSteeringConfig
  language: 'zh-CN' | 'en-US'
}

/** Compression strength; multiplies the adaptive retention budget. */
export type CompressionAggressiveness = 'conservative' | 'moderate' | 'aggressive'

/**
 * Live-zone context compression: the only two knobs the UI exposes.
 *
 * Off by default. A rewrite is only free when it cannot disturb the provider's
 * prompt cache, so this ships gated and is enabled deliberately.
 */
export interface CompressionConfig {
  enabled: boolean
  aggressiveness: CompressionAggressiveness
}

export const COMPRESSION_AGGRESSIVENESS: CompressionAggressiveness[] = [
  'conservative',
  'moderate',
  'aggressive',
]

/**
 * Ships disabled: the feature rewrites request bytes, so it is opt-in and
 * enabled deliberately rather than inherited from an upgrade.
 */
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  enabled: false,
  aggressiveness: 'moderate',
}

/**
 * Output-side verbosity steering.
 *
 * Deliberately a SEPARATE switch from `compression`: that one rewrites request
 * bytes (and is therefore bounded by prompt-cache economics), while this one
 * changes what the model writes back. A user may reasonably want one and not the
 * other, and bundling them would make each one's risk inherit the other's.
 *
 * `level` is 1..3; 0 means "do not steer". It only takes effect when `enabled`
 * is true, so a stored non-zero level cannot steer after the switch is turned
 * off.
 */
export interface OutputSteeringConfig {
  enabled: boolean
  level: number
}

export const OUTPUT_STEERING_LEVELS = [1, 2, 3]

export const DEFAULT_OUTPUT_STEERING_CONFIG: OutputSteeringConfig = {
  enabled: false,
  level: 2,
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: string
  timestamp: number
  level: LogLevel
  message: string
  accountId?: string
  providerId?: string
  requestId?: string
  data?: Record<string, unknown>
}

export interface ProxyStatus {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface ProxyStatistics {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
}

export interface ProviderCheckResult {
  providerId: string
  status: ProviderStatus
  latency?: number
  error?: string
  /** Machine-readable cause; the UI turns it into its own wording */
  reason?: string
}

export interface OAuthResult {
  success: boolean
  providerId?: string
  providerType?: ProviderVendor
  credentials?: Record<string, string>
  account?: Account
  accountInfo?: {
    userId?: string
    email?: string
    name?: string
  }
  error?: string
}

export interface ValidationResult {
  valid: boolean
  error?: string
  validatedAt: number
  accountInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
    expiresAt?: number
  }
}

export interface SessionConfig {
  sessionTimeout: number
  maxMessagesPerSession: number
  deleteAfterTimeout: boolean
  maxSessionsPerAccount: number
}

export interface RequestLogEntry {
  /** Log ID */
  id: string
  /** Timestamp */
  timestamp: number
  /** Request status */
  status: 'success' | 'error'
  /** HTTP status code */
  statusCode: number

  /** HTTP method */
  method: string
  /** Request URL path */
  url: string
  /** Requested model name */
  model: string
  /** Actual model used (after mapping) */
  actualModel?: string

  /** Provider ID */
  providerId?: string
  /** Provider name */
  providerName?: string
  /** Account ID */
  accountId?: string
  /** Account name */
  accountName?: string

  /** Request body JSON string */
  requestBody?: string
  /** User input extracted from messages (truncated to 200 chars) */
  userInput?: string

  /** Web search enabled */
  webSearch?: boolean
  /** Reasoning effort level */
  reasoningEffort?: 'low' | 'medium' | 'high'

  /**
   * Output cap the client asked for (`max_completion_tokens` first, then `max_tokens`).
   * Absent when the client sent neither - never defaulted here, since the upstream default is unknown.
   */
  maxTokens?: number

  /** Response status code */
  responseStatus: number
  /** Response preview (truncated) */
  responsePreview?: string
  /** Response body JSON string */
  responseBody?: string
  /** Finish reason the client actually received; absent when the upstream never announced an ending */
  finishReason?: string
  /** Streaming only: the upstream ended without a finish reason, so the turn the client got is incomplete */
  streamTruncated?: boolean

  /** Request latency in milliseconds */
  latency: number
  /** Whether streaming request */
  isStream: boolean

  /** Error message */
  errorMessage?: string
  /** Error stack trace */
  errorStack?: string

  /**
   * Decision record for a request that asked for the virtual `auto` model.
   * Absent for every other request; candidates are ranked display names, capped.
   */
  auto?: {
    prefer: AutoPreference
    reason: 'only' | 'sticky' | 'score'
    attempts: number
    candidates: string[]
    /** Contracts that could not be met but the request was routed anyway */
    degraded?: string[]
  }

  /**
   * Context-compression record. Absent when the feature is disabled, so a log
   * row only carries this field when a decision was actually made.
   * Token figures are ESTIMATES and never the upstream-reported usage.
   */
  compression?: {
    /** Compressors that rewrote something, e.g. ['json']. */
    applied: string[]
    tokensBefore: number
    tokensAfter: number
    saved: number
    ratio: number
    /** CCR ids the model could retrieve through the management API. */
    ccrHashes?: string[]
    /** Why the request was forwarded unchanged. */
    skipped?: string
  }
  /**
   * Cross-turn duplication measurement. OBSERVATION ONLY — nothing was rewritten.
   *
   * Recorded even when compression is disabled, because its whole purpose is to
   * decide whether folding repeated content is worth building at all. All
   * character counts are raw bytes of message text, not tokens.
   */
  duplication?: {
    /** Message blocks large enough to compare. */
    blocks: number
    /** Characters examined, after the per-request caps. */
    scannedChars: number
    /** Characters that could be folded if every verbatim repeat collapsed. */
    duplicatedChars: number
    /** Number of qualifying contiguous runs. */
    runs: number
    /** Longest contiguous duplicated run, in lines. */
    longestRunLines: number
    /** True when a cap stopped the scan before the whole prompt. */
    truncated: boolean
  }
  /**
   * Which turn of its conversation this request was, as attributed by the
   * survivorship tracker (1 = the first turn we observed).
   *
   * OBSERVATION ONLY. Kept on the log so `expected_reads` — the number a
   * cross-turn deduplication budget needs and cannot know at request time — can
   * be estimated afterwards. Absent when the conversation key could not be
   * derived (no system prompt and no user message, or malformed content).
   */
  conversationTurn?: number
}

export interface RequestLogConfig {
  enabled: boolean
  maxEntries: number
  includeBodies: boolean
  maxBodyChars: number
  redactSensitiveData: boolean
}

/**
 * One day of a per-day aggregate. Counts are `null` when the retained logs
 * cannot speak for that day: a `0` there would read as "that day had no
 * traffic" while the real answer is "those rows are no longer stored".
 */
export interface RequestLogTrendPoint {
  date: string
  total: number | null
  success: number | null
  error: number | null
  avgLatency: number | null
}

export interface AppLogTrendPoint {
  date: string
  total: number | null
  info: number | null
  warn: number | null
  error: number | null
}

export interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

export interface ManagementApiResponse<T = unknown> {
  success: boolean
  data?: T
  error?: ManagementApiError
}

export interface ManagementApiError {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface ManagementApiPaginationParams {
  page?: number
  limit?: number
}

export interface ManagementApiPaginatedResponse<T> {
  items: T[]
  total: number
  page: number
  limit: number
  totalPages: number
}

export interface CreateProviderRequest {
  name: string
  type: ProviderType
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
}

export interface UpdateProviderRequest {
  name?: string
  apiEndpoint?: string
  chatPath?: string
  headers?: Record<string, string>
  enabled?: boolean
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
}

export interface ProviderStatusRequest {
  enabled: boolean
}

export interface CreateAccountRequest {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  dailyLimit?: number
}

export interface UpdateAccountRequest {
  name?: string
  email?: string
  credentials?: Record<string, string>
  dailyLimit?: number
}

export interface CreateApiKeyRequest {
  name: string
  description?: string
}

export interface UpdateApiKeyRequest {
  name?: string
  description?: string
  enabled?: boolean
}

export interface CreateModelMappingRequest {
  requestModel: string
  actualModel: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface UpdateModelMappingRequest {
  actualModel?: string
  preferredProviderId?: string
  preferredAccountId?: string
}

export interface ProxyStatusResponse {
  isRunning: boolean
  port: number
  host: string
  uptime: number
  connections: number
}

export interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy' | 'degraded'
  version: string
  uptime: number
  timestamp: number
  components?: {
    proxy: 'up' | 'down'
    database: 'up' | 'down'
    managementApi: 'up' | 'down'
  }
}

export interface StatisticsResponse {
  totalRequests: number
  successRequests: number
  failedRequests: number
  avgLatency: number
  requestsPerMinute: number
  activeConnections: number
  modelUsage: Record<string, number>
  providerUsage: Record<string, number>
  accountUsage: Record<string, number>
  dailyStats?: Record<string, {
    totalRequests: number
    successRequests: number
    failedRequests: number
  }>
}

export interface ConfigUpdateRequest {
  proxyPort?: number
  proxyHost?: string
  loadBalanceStrategy?: LoadBalanceStrategy
  theme?: Theme
  autoStart?: boolean
  autoStartProxy?: boolean
  minimizeToTray?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  logRetentionDays?: number
  requestLogConfig?: Partial<RequestLogConfig>
  requestTimeout?: number
  retryCount?: number
  enableApiKey?: boolean
  oauthProxyMode?: 'system' | 'none'
  sessionConfig?: SessionConfig
  toolCallingConfig?: Partial<ToolCallingConfig>
  toolPromptConfig?: LegacyToolPromptConfig
  managementApi?: ManagementApiConfig
  autoRouting?: Partial<AutoRoutingConfig>
}

export interface EffectiveModel {
  displayName: string
  actualModelId: string
  isCustom: boolean
  /** Where this entry came from, so the UI can label it truthfully */
  source: 'builtin' | 'fetched' | 'custom'
}

/**
 * One catalogue row, served or not. The model management page lists the whole
 * catalogue so a stopped model can be started again from the same place.
 */
export interface CatalogueModel extends EffectiveModel {
  /** false = stopped: neither advertised on `/v1/models` nor routable, but still listed */
  served: boolean
}

/** How an upstream payload is read into display-name / actual-id pairs */
export type ModelsFetchReader =
  | 'openai-list'
  /** OpenAI-shaped `data[]` where only entries with `isFree: true` are kept (Kilo pool) */
  | 'openai-free-list'
  | 'auto'

/** Where one credential field goes when calling a provider's model list */
export interface ModelsFetchAuthRule {
  /** Key in account.credentials */
  from: string
  into: 'header' | 'cookie'
  /** Header name, for into = header */
  header?: string
  /** Prefix placed before the value inside the header, e.g. "Bearer " */
  prefix?: string
  /** Cookie name, for into = cookie */
  cookie?: string
}

/**
 * Declarative description of a provider's online model list source.
 * Lives in shared/types because the fetch outcome crosses the IPC boundary.
 */
export interface ModelsFetchConfig {
  url: string
  method?: 'GET' | 'POST'
  /** JSON body, for the gateways that need POST with an empty object */
  body?: Record<string, unknown>
  /** Payload reader; 'auto' tries every known reader and fails loudly when none match */
  reader?: ModelsFetchReader
  /**
   * How the active account's credentials reach this request. Declaring any rule means
   * an active account is required; an empty list means the endpoint answers anonymously.
   */
  auth?: ModelsFetchAuthRule[]
  /** Headers merged over the provider's own headers for this request */
  headers?: Record<string, string>
}

export interface FetchedModel {
  displayName: string
  actualModelId: string
}

export type ModelsFetchFailure =
  | 'unsupported'
  | 'no_active_account'
  | 'missing_credential_field'
  | 'http_status'
  | 'empty'
  | 'unrecognized_shape'
  | 'network_error'
  /** Aggregate sync: every stored key was rejected by the list endpoint. */
  | 'invalid_api_key'

export type ModelsFetchResult =
  | { ok: true; models: FetchedModel[]; detail?: string }
  | { ok: false; reason: ModelsFetchFailure; detail?: string }
