import type { AggregateWire } from './aggregate'

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

export type LoadBalanceStrategy = 'round-robin' | 'fill-first' | 'failover'

export interface AutoRoutingConfig {
  /** Enables the virtual `auto` model. When off, `auto` is hidden from /v1/models and rejected. */
  enabled: boolean
  /** Maximum number of candidates tried before giving up on one request. */
  maxAttempts: number
  /** How long a conversation stays pinned to the model it first succeeded on. 0 disables stickiness. */
  stickyMinutes: number
}

export const DEFAULT_AUTO_ROUTING_CONFIG: AutoRoutingConfig = {
  enabled: true,
  maxAttempts: 3,
  stickyMinutes: 30,
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
  language: 'zh-CN' | 'en-US'
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

  /** Response status code */
  responseStatus: number
  /** Response preview (truncated) */
  responsePreview?: string
  /** Response body JSON string */
  responseBody?: string

  /** Request latency in milliseconds */
  latency: number
  /** Whether streaming request */
  isStream: boolean

  /** Error message */
  errorMessage?: string
  /** Error stack trace */
  errorStack?: string
}

export interface RequestLogConfig {
  enabled: boolean
  maxEntries: number
  includeBodies: boolean
  maxBodyChars: number
  redactSensitiveData: boolean
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

export type ModelsFetchResult =
  | { ok: true; models: FetchedModel[]; detail?: string }
  | { ok: false; reason: ModelsFetchFailure; detail?: string }
