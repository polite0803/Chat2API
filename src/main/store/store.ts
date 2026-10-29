/**
 * Credential Storage Module - Core Storage Implementation
 * Uses electron-store for persistent storage
 * Uses Electron's safeStorage API for sensitive data encryption
 */

import { app, safeStorage, BrowserWindow } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import {
  StoreSchema,
  AppConfig,
  Account,
  Provider,
  LogEntry,
  DEFAULT_CONFIG,
  BUILTIN_PROVIDERS,
  LogLevel,
  SessionRecord,
  SessionConfig,
  DEFAULT_SESSION_CONFIG,
  ChatMessage,
  RequestLogEntry,
  RequestLogConfig,
  PersistentStatistics,
  DailyStatistics,
  DEFAULT_STATISTICS,
  EffectiveModel,
  CatalogueModel,
  ProviderModelOverrides,
  DEFAULT_USER_MODEL_OVERRIDES,
  UserModelOverrides,
  CustomModel,
  FetchedModel,
  DEFAULT_REQUEST_LOG_CONFIG,
  normalizeModelMappingsWithDefaults,
} from './types'
import { localDayKey, recentLocalDays } from '../../shared/localDay'
import {
  accumulateDayBucket,
  normalizeDayBucket,
  summarizeDay,
  tokenDayKey,
  trimDays,
  type DayTokenSummary,
} from '../../shared/tokenAccounting.ts'
import { sendRequestLog } from '../ipc/logBroadcast'
import { RequestLogManager } from '../requestLogs/manager'
import { normalizeRequestLogConfig } from '../requestLogs/types'
import { setContentLoggingEnabled } from '../proxy/utils/debugContent'
import {
  compareStoreSnapshot,
  legacyBackupCandidates,
  orphanedPromptPayload,
  planKeySetup,
} from './keyMigration'
import { normalizeToolCallingConfig } from '../../shared/toolCalling'
import { applyServed, buildModelCatalogue, namespaceModelOverrides } from './modelServing'
import { DEFAULT_AUTO_ROUTING_CONFIG, RETIRED_PROVIDER_IDS } from '../../shared/types'
import { normalizeAutoRoutingConfig } from './autoRoutingConfig'
import { normalizeCompressionConfig } from './compressionConfig'
import { normalizeOutputSteeringConfig } from './outputSteeringConfig'
import type { AppLogTrendPoint, AutoRoutingConfig, RequestLogTrendPoint } from '../../shared/types'
import { AppLogManager } from '../appLogs/manager'
import { QuotaLedger } from '../proxy/quota/ledger'
import { syncBuiltinProvider } from './providerSync'
import { syncAutoStart } from '../autostartHost'
import type { AppLogFilter } from '../appLogs/types'

// Dynamically import electron-store (ESM module)
let Store: any = null

/**
 * Storage Instance Type Definition
 */
type StoreType = any


/**
 * Storage Manager Class
 * Responsible for data persistence and encryption
 */
class StoreManager {
  private store: StoreType | null = null
  private isInitialized: boolean = false
  private mainWindow: BrowserWindow | null = null
  private initializationError: Error | null = null
  private requestLogManager: RequestLogManager | null = null
  private appLogManager: AppLogManager | null = null
  private quotaLedger: QuotaLedger | null = null
  private encryptionKey: string | undefined = undefined
  private keyFilePath: string | null = null
  private dataFileExistedBeforeInit = false

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window
  }

  /**
   * Check if storage has initialization error
   */
  hasInitializationError(): boolean {
    return this.initializationError !== null
  }

  /**
   * Get initialization error
   */
  getInitializationError(): Error | null {
    return this.initializationError
  }

  /**
   * Initialize Storage
   * Create storage instance and initialize default data
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Dynamically import electron-store (ESM module)
    if (!Store) {
      const module = await import('electron-store')
      Store = module.default
    }

    const storagePath = this.getStoragePath()

    try {
      this.encryptionKey = this.resolveEncryptionKey(storagePath)
      this.store = new Store({
        name: 'data',
        cwd: storagePath,
        defaults: this.getDefaultData(),
        encryptionKey: this.encryptionKey,
      })
      this.orphanSystemPrompts(storagePath)

      await this.initializeAppLogManager(storagePath)
      await this.initializeRequestLogManager(storagePath)
      this.initializeQuotaLedger(storagePath)
      this.initializeDefaultModelMappings()
      await this.initializeDefaultProviders()
      this.isInitialized = true
      this.initializationError = null
    } catch (error) {
      console.error('[Store] Failed to initialize storage:', error)
      this.initializationError = error instanceof Error ? error : new Error(String(error))
      
      // Never replace a data file that held real data: a wrong or missing key
      // would turn "cannot decrypt" into "silently wiped".
      if (this.dataFileExistedBeforeInit && this.keyFilePath) {
        console.error(
          '[Store] Existing data.json could not be read. Move it aside manually to start over; refusing to replace it.',
        )
        throw this.initializationError
      }

      // Try to recover by backing up corrupted data and reinitializing
      try {
        await this.recoverFromCorruptedData(storagePath)
        this.store = new Store({
          name: 'data',
          cwd: storagePath,
          defaults: this.getDefaultData(),
          encryptionKey: this.encryptionKey,
        })
        await this.initializeAppLogManager(storagePath)
        await this.initializeRequestLogManager(storagePath)
        this.initializeQuotaLedger(storagePath)
        this.initializeDefaultModelMappings()
        this.isInitialized = true
        this.initializationError = null
        console.log('[Store] Successfully recovered from corrupted data')
      } catch (recoveryError) {
        console.error('[Store] Failed to recover from corrupted data:', recoveryError)
        throw this.initializationError
      }
    }
  }

  /**
   * Recover from corrupted data file
   * Backup the corrupted file and create a new one
   */
  private async recoverFromCorruptedData(storagePath: string): Promise<void> {
    const { renameSync, existsSync } = await import('fs')
    const { join } = await import('path')
    
    const dataPath = join(storagePath, 'data.json')
    const backupPath = join(storagePath, `data.corrupted.${Date.now()}.json`)
    
    if (existsSync(dataPath)) {
      console.log('[Store] Backing up corrupted data file to:', backupPath)
      try {
        renameSync(dataPath, backupPath)
        console.log('[Store] Corrupted data file backed up successfully')
      } catch (backupError) {
        console.error('[Store] Failed to backup corrupted data:', backupError)
        throw backupError
      }
    }
  }

  /**
   * Get Storage Path
   * Storage path: ~/.chat2api/
   */
  private getStoragePath(): string {
    return join(homedir(), '.chat2api')
  }

  /** Key used by every release before machine-bound keys; only read during migration */
  private static readonly LEGACY_ENCRYPTION_KEY = 'chat2api-fixed-encryption-key-v1'

  /**
   * Resolves the key that encrypts data.json.
   *
   * The key is random per install and sealed with the OS keystore, so a copied
   * data.json cannot be decrypted on another machine. A data file written by an
   * older release is migrated once: read with the legacy key, backed up, then
   * rewritten with the new key and verified before the old file is dropped.
   */
  private resolveEncryptionKey(storagePath: string): string | undefined {
    const keyPath = join(storagePath, 'store.key')
    const dataPath = join(storagePath, 'data.json')
    this.dataFileExistedBeforeInit = existsSync(dataPath)

    let keystoreAvailable = false
    try {
      keystoreAvailable = safeStorage.isEncryptionAvailable()
    } catch (error) {
      console.warn('[Store] OS keystore probe failed, falling back to unencrypted storage:', error)
    }

    const plan = planKeySetup({
      keystoreAvailable,
      keyFileExists: existsSync(keyPath),
      dataFileExists: this.dataFileExistedBeforeInit,
    })

    if (plan === 'unencrypted') {
      if (this.dataFileExistedBeforeInit) {
        console.warn('[Store] OS keystore unavailable; data.json is stored unencrypted')
      }
      return undefined
    }

    this.keyFilePath = keyPath
    if (plan === 'reuse') {
      const key = this.readKeyFile(keyPath)
      this.restoreMissingDataFile(storagePath, key)
      return key
    }
    if (plan === 'create') return this.createKeyFile(keyPath)
    return this.migrateLegacyKey(storagePath, this.createKeyFile(keyPath))
  }

  private readKeyFile(keyPath: string): string {
    const sealed = readFileSync(keyPath, 'utf8').trim()
    const key = safeStorage.decryptString(Buffer.from(sealed, 'base64'))
    if (!key) throw new Error('store.key decrypted to an empty key')
    return key
  }

  private createKeyFile(keyPath: string): string {
    const key = randomBytes(32).toString('hex')
    writeFileSync(keyPath, safeStorage.encryptString(key).toString('base64'), { mode: 0o600 })
    return key
  }

  private nextBackupPath(dataPath: string): string {
    const base = `${dataPath}.pre-key-migration.bak`
    return existsSync(base) ? `${base}.${Date.now()}` : base
  }

  private migrateLegacyKey(storagePath: string, key: string): string {
    this.rewriteWithKey(storagePath, join(storagePath, 'data.json'), key)
    return key
  }

  /**
   * data.json can go missing two ways: a downgrade cannot read it and renames it
   * to data.corrupted.<ts>.json, or an interrupted migration leaves only a .bak.
   * Rather than start empty, put the newest copy back - as-is when it is already
   * under this install's key, or re-encrypted when it is the older fixed-key file.
   */
  private restoreMissingDataFile(storagePath: string, key: string): void {
    const dataPath = join(storagePath, 'data.json')
    if (existsSync(dataPath)) return

    let candidates: string[] = []
    try {
      candidates = legacyBackupCandidates(readdirSync(storagePath))
    } catch (error) {
      console.warn('[Store] Could not list the data directory while looking for a copy to restore:', error)
      return
    }

    for (const name of candidates) {
      const sourcePath = join(storagePath, name)
      copyFileSync(sourcePath, dataPath)
      if (this.canReadWith(dataPath, storagePath, key)) {
        console.warn('[Store] data.json was missing; restored it as-is from', name)
        return
      }
      try {
        this.rewriteWithKey(storagePath, sourcePath, key)
        console.warn('[Store] data.json was missing; restored it from', name)
        return
      } catch (error) {
        console.warn('[Store] Could not restore', name, '-', error instanceof Error ? error.message : error)
        unlinkSync(dataPath)
      }
    }
  }

  /** Read-only probe: succeeds when the file on disk decrypts with this key. */
  private canReadWith(dataPath: string, storagePath: string, key: string): boolean {
    try {
      const probe = new Store({
        name: 'data',
        cwd: storagePath,
        defaults: {},
        encryptionKey: key,
      })
      void probe.store
      return true
    } catch {
      return false
    }
  }
  /**
   * Reads a legacy-encrypted file with the old fixed key and writes the same
   * payload back under `key`, keeping a byte copy first. Any failure restores
   * the live file from that copy.
   */
  private rewriteWithKey(storagePath: string, sourcePath: string, key: string): void {
    const dataPath = join(storagePath, 'data.json')
    const backupPath = this.nextBackupPath(dataPath)

    let snapshot: Record<string, unknown>
    try {
      const legacy = new Store({
        name: 'data',
        cwd: storagePath,
        defaults: {},
        encryptionKey: StoreManager.LEGACY_ENCRYPTION_KEY,
      })
      snapshot = legacy.store
      if (!snapshot || Object.keys(snapshot).length === 0) {
        throw new Error('legacy store decrypted to an empty object')
      }
    } catch (error) {
      throw new Error(
        `Existing ${sourcePath.endsWith('data.json') ? 'data.json' : sourcePath} cannot be read with the legacy key, refusing to migrate: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }

    copyFileSync(sourcePath, dataPath)
    copyFileSync(dataPath, backupPath)
    // the legacy file must be out of the way: the new store would otherwise try to
    // decrypt it with the new key at construction. The backup above is the copy.
    unlinkSync(dataPath)

    try {
      const rewritten = new Store({
        name: 'data',
        cwd: storagePath,
        defaults: {},
        encryptionKey: key,
      })
      rewritten.store = snapshot
      const check = compareStoreSnapshot(snapshot, rewritten.store)
      if (!check.ok) throw new Error(`verification failed: ${check.detail}`)
      console.log('[Store] Wrote data.json under the machine-bound key; backup at', backupPath)
    } catch (error) {
      copyFileSync(backupPath, dataPath)
      throw new Error(
        `Key rewrite failed and data.json was restored from backup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /**
   * The prompt library was removed; keep whatever a user had written next to the
   * data file instead of silently dropping it from the store.
   */
  private orphanSystemPrompts(storagePath: string): void {
    const leftovers = this.store?.get('systemPrompts')
    const payload = orphanedPromptPayload(leftovers)
    if (!payload) return

    const target = join(storagePath, 'system-prompts.orphaned.json')
    try {
      if (!existsSync(target)) writeFileSync(target, payload, 'utf8')
      this.store!.delete('systemPrompts')
      console.log('[Store] Moved leftover system prompts out of data.json to', target)
    } catch (error) {
      console.warn('[Store] Could not move leftover system prompts aside; leaving them in place:', error)
    }
  }
  /**
   * Get Default Data Structure
   */
  private getDefaultData(): StoreSchema {
    return {
      providers: [],
      accounts: [],
      config: DEFAULT_CONFIG,
      logs: [],
      requestLogs: [],
      sessions: [],
      statistics: DEFAULT_STATISTICS,
      // Per-day token counters start empty; an upgrade simply has no history.
      tokenUsage: {},
      userModelOverrides: DEFAULT_USER_MODEL_OVERRIDES,
    }
  }

  private async initializeRequestLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.requestLogManager = new RequestLogManager({
      storageDir: join(storagePath, 'request-logs'),
      config: config.requestLogConfig,
    })
    setContentLoggingEnabled(config.requestLogConfig.includeBodies)
    await this.requestLogManager.initialize()

    const legacyRequestLogs = this.store?.get('requestLogs') || []
    if (legacyRequestLogs.length > 0) {
      await this.requestLogManager.migrateLegacyLogs(legacyRequestLogs)
      this.store?.set('requestLogs', [])
    }
  }

  private initializeQuotaLedger(storagePath: string): void {
    this.quotaLedger = new QuotaLedger(storagePath)
    this.quotaLedger.initialize()
  }

  private async initializeAppLogManager(storagePath: string): Promise<void> {
    const config = this.normalizeConfig(this.store?.get('config') || DEFAULT_CONFIG)
    this.appLogManager = new AppLogManager({
      storageDir: join(storagePath, 'logs'),
      maxEntries: this.getMaxLogEntries(config),
    })
    await this.appLogManager.initialize()

    const legacyLogs = this.store?.get('logs') || []
    if (legacyLogs.length > 0) {
      await this.appLogManager.migrateLegacyLogs(legacyLogs)
      this.appLogManager.flushSync()
      this.store?.set('logs', [])
    }
  }

  private getMaxLogEntries(config: AppConfig): number {
    return config.logRetentionDays * 1000
  }

  private normalizeConfig(config: Partial<AppConfig>): AppConfig {
    const rawConfig = {
      ...DEFAULT_CONFIG,
      ...config,
    }
    const rawToolCallingConfig = rawConfig.toolCallingConfig ?? rawConfig.toolPromptConfig

    return {
      ...rawConfig,
      modelMappings: normalizeModelMappingsWithDefaults(rawConfig.modelMappings),
      requestLogConfig: normalizeRequestLogConfig(
        rawConfig.requestLogConfig || DEFAULT_REQUEST_LOG_CONFIG,
      ),
      toolCallingConfig: normalizeToolCallingConfig(rawToolCallingConfig),
      toolPromptConfig: undefined,
      autoRouting: normalizeAutoRoutingConfig(rawConfig.autoRouting),
      compression: normalizeCompressionConfig(rawConfig.compression),
      outputSteering: normalizeOutputSteeringConfig(rawConfig.outputSteering),
    }
  }

  private initializeDefaultModelMappings(): void {
    const rawConfig = this.store?.get('config') || DEFAULT_CONFIG
    this.store?.set('config', this.normalizeConfig(rawConfig))
  }

  /**
   * Initialize Default Providers
   * Clear provider list, users create providers by adding accounts
   */
  private async initializeDefaultProviders(): Promise<void> {
    const providers = this.store?.get('providers') || []
    const builtinIds = BUILTIN_PROVIDERS.map(p => p.id)
    
    const validProviders = providers.filter((p: Provider) => {
      if (p.type === 'builtin') {
        return builtinIds.includes(p.id)
      }
      return true
    })
    
    const userModelOverrides: UserModelOverrides = {
      ...(this.store?.get('userModelOverrides') || {}),
    }
    let userModelOverridesChanged = false

    // Retired providers leave accounts (cookies, refresh tokens, SSO tickets)
    // and per-model switches behind. Delete them instead of keeping orphans.
    const retiredIds = new Set<string>(RETIRED_PROVIDER_IDS)
    const accounts = (this.store?.get('accounts') || []) as Account[]
    const keptAccounts = accounts.filter(account => !retiredIds.has(account.providerId))
    if (keptAccounts.length !== accounts.length) {
      this.store?.set('accounts', keptAccounts)
    }
    for (const id of RETIRED_PROVIDER_IDS) {
      if (id in userModelOverrides) {
        delete userModelOverrides[id]
        userModelOverridesChanged = true
      }
    }

    // OpenCode 的模型名此前是裸 id，现在与其它供应商一样带 `opencode/` 前缀。
    // 供应商记录本身由上面的启动同步按随包配置重写，但用户侧的目录残留
    // （上次同步的清单、停用名单）也要搬进新命名空间，否则同一个上游模型
    // 会在目录里出现新旧两行。
    const opencodeOverrides = userModelOverrides['opencode']
    if (opencodeOverrides) {
      const migrated = namespaceModelOverrides(opencodeOverrides, 'opencode')
      if (migrated.changed) {
        userModelOverrides['opencode'] = migrated.next
        userModelOverridesChanged = true
      }
    }

    const updatedProviders = validProviders.map((p: Provider) => {
      const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === p.id)
      if (!builtinConfig) return p

      if (p.type !== 'builtin') {
        console.warn('[Store] Repairing builtin provider record:', p.id, '(stored type:', p.type ?? 'missing', ')')
      }
      return syncBuiltinProvider(p, builtinConfig)
    })
    
    if (userModelOverridesChanged) {
      this.store?.set('userModelOverrides', userModelOverrides)
    }
    this.store?.set('providers', updatedProviders)

    // 凭据型供应商（OpenCode）自己不需要账号，但负载均衡要有一个 active 账号
    for (const provider of updatedProviders) {
      if (provider.type === 'builtin') this.ensureLocalAccount(provider.id)
    }
  }

  /**
   * Ensure provider exists, create if not
   */
  ensureProviderExists(providerId: string): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') || []
    const exists = providers.some((p: Provider) => p.id === providerId)
    
    if (!exists) {
      const builtinConfig = BUILTIN_PROVIDERS.find(bp => bp.id === providerId)
      if (builtinConfig) {
        const now = Date.now()
        const newProvider: Provider = {
          id: builtinConfig.id,
          name: builtinConfig.name,
          type: 'builtin',
          authType: builtinConfig.authType,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          headers: builtinConfig.headers,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          description: builtinConfig.description,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
          supportsModelFetch: Boolean(builtinConfig.modelsFetch) || builtinConfig.runtimeModels === true,
        }
        providers.push(newProvider)
        this.store!.set('providers', providers)
        console.log('[Store] Created missing provider:', providerId)
        this.ensureLocalAccount(providerId)
      }
    }
  }

  /**
   * 有些内置供应商不需要任何凭据（OpenCode 走本机运行时）。但负载均衡要有一个
   * active 账号才肯把请求发出去，所以给它们配一个空的本地账号。
   */
  ensureLocalAccount(providerId: string): void {
    // 只看 store 有没有建好：这个方法会被 initialize() 内部的启动同步调用，
    // 那时 isInitialized 还没置位，用「已初始化」判据会把整个启动流程打断
    if (!this.store) return
    const config = BUILTIN_PROVIDERS.find(bp => bp.id === providerId)
    if (!config) return
    if ((config.credentialFields?.length ?? 0) > 0) return

    const accounts = this.store!.get('accounts') || []
    if (accounts.some((a: Account) => a.providerId === providerId)) return

    const now = Date.now()
    const account: Account = {
      id: this.generateId(),
      providerId,
      name: `${config.name} local`,
      credentials: {},
      status: 'active',
      createdAt: now,
      updatedAt: now,
      requestCount: 0,
      todayUsed: 0,
      lastStatusCheck: now,
      lastUsed: now,
    }
    accounts.push(account)
    this.store!.set('accounts', accounts)
    console.log('[Store] Created local account for credential-less provider:', providerId)
  }

  /**
   * Ensure Storage is Initialized
   */
  private ensureInitialized(): void {
    if (!this.isInitialized || !this.store) {
      const errorMsg = this.initializationError 
        ? `Storage initialization failed: ${this.initializationError.message}`
        : 'Storage not initialized, please call initialize() first'
      throw new Error(errorMsg)
    }
  }

  private getLogPriority(level: LogLevel): number {
    switch (level) {
      case 'debug':
        return 10
      case 'info':
        return 20
      case 'warn':
        return 30
      case 'error':
        return 40
      default:
        return 20
    }
  }

  private shouldRecordLog(level: LogLevel): boolean {
    const config = this.normalizeConfig(this.store!.get('config') || DEFAULT_CONFIG)
    return this.getLogPriority(level) >= this.getLogPriority(config.logLevel)
  }

  private getCombinedLogs(): LogEntry[] {
    return this.getAppLogManager().exportLogs()
  }

  flushPendingWrites(): void {
    this.appLogManager?.flushSync()
    this.requestLogManager?.flushSync()
    this.quotaLedger?.flushSync()
  }

  /**
   * Encrypt Sensitive Data
   * @param data Data to encrypt
   * @returns Encrypted string
   */
  encryptData(data: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[Store] System keychain unavailable - credentials will be stored unencrypted')
      return data
    }
    try {
      const encrypted = Buffer.from(safeStorage.encryptString(data))
      // Some keychains report available but fail to round-trip (headless Linux without libsecret)
      if (safeStorage.decryptString(encrypted) !== data) {
        console.error('[Store] Encryption round-trip failed - credentials will be stored unencrypted')
        return data
      }
      return encrypted.toString('base64')
    } catch (error) {
      console.error('Failed to encrypt data:', error)
    }
    return data
  }

  /**
   * Decrypt Sensitive Data
   * @param encryptedData Encrypted data
   * @returns Decrypted string
   */
  decryptData(encryptedData: string): string {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const buffer = Buffer.from(encryptedData, 'base64')
        return safeStorage.decryptString(buffer)
      }
    } catch (error) {
      console.error('Failed to decrypt data:', error)
    }
    return encryptedData
  }

  /**
   * Encrypt Credentials Object
   * @param credentials Credentials object
   * @returns Encrypted credentials object
   */
  encryptCredentials(credentials: Record<string, string>): Record<string, string> {
    const encrypted: Record<string, string> = {}
    
    for (const [key, value] of Object.entries(credentials)) {
      encrypted[key] = this.encryptData(value)
    }
    
    return encrypted
  }

  /**
   * Decrypt Credentials Object
   * @param encryptedCredentials Encrypted credentials object
   * @returns Decrypted credentials object
   */
  decryptCredentials(encryptedCredentials: Record<string, string>): Record<string, string> {
    const decrypted: Record<string, string> = {}
    
    for (const [key, value] of Object.entries(encryptedCredentials)) {
      decrypted[key] = this.decryptData(value)
    }
    
    return decrypted
  }

  // ==================== Provider Operations ====================

  /**
   * Get All Providers
   */
  getProviders(): Provider[] {
    this.ensureInitialized()
    return this.store!.get('providers') || []
  }

  /**
   * Get Provider By ID
   */
  getProviderById(id: string): Provider | undefined {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    return providers.find((p: Provider) => p.id === id)
  }

  /**
   * Add Provider
   */
  addProvider(provider: Provider): void {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    providers.push(provider)
    this.store!.set('providers', providers)
  }

  /**
   * Update Provider
   */
  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    const index = providers.findIndex((p: Provider) => p.id === id)
    
    if (index === -1) {
      return null
    }
    
    providers[index] = {
      ...providers[index],
      ...updates,
      updatedAt: Date.now(),
    }
    
    this.store!.set('providers', providers)
    return providers[index]
  }

  /**
   * Delete Provider
   */
  deleteProvider(id: string): boolean {
    this.ensureInitialized()
    const providers = this.store!.get('providers') as Provider[] || []
    const index = providers.findIndex((p: Provider) => p.id === id)
    
    if (index === -1) {
      return false
    }
    
    providers.splice(index, 1)
    this.store!.set('providers', providers)
    
    const accounts = this.store!.get('accounts') as Account[] || []
    const filteredAccounts = accounts.filter((a: Account) => a.providerId !== id)
    this.store!.set('accounts', filteredAccounts)
    
    return true
  }

  // ==================== Model Overrides Operations ====================

  /**
   * Get Model Overrides for a Provider
   * Returns user customizations to built-in provider models
   */
  getModelOverrides(providerId: string): ProviderModelOverrides | undefined {
    this.ensureInitialized()
    const userModelOverrides = this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
    return userModelOverrides[providerId]
  }

  /**
   * Check if Provider has Model Overrides
   * Returns true if provider has user-added models or excluded models
   */
  hasModelOverrides(providerId: string): boolean {
    const overrides = this.getModelOverrides(providerId)
    if (!overrides) return false
    
    return (
      (overrides.addedModels && overrides.addedModels.length > 0) ||
      (overrides.excludedModels && overrides.excludedModels.length > 0)
    )
  }

  // ==================== Account Operations ====================

  /**
   * Get All Accounts
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    
    if (includeCredentials) {
      return accounts.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return accounts
  }

  /**
   * Get Account By ID
   * @param includeCredentials Whether to include decrypted credentials
   */
  getAccountById(id: string, includeCredentials: boolean = false): Account | undefined {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const account = accounts.find((a: Account) => a.id === id)
    
    if (account && includeCredentials) {
      return {
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }
    }
    
    return account
  }

  /**
   * Get Accounts By Provider ID
   */
  getAccountsByProviderId(providerId: string, includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const filtered = accounts.filter((a: Account) => a.providerId === providerId)
    
    if (includeCredentials) {
      return filtered.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return filtered
  }

  /**
   * Add Account
   * Credentials are automatically encrypted before storage
   */
  addAccount(account: Account): void {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') || []
    
    const encryptedAccount: Account = {
      ...account,
      credentials: this.encryptCredentials(account.credentials),
    }
    
    accounts.push(encryptedAccount)
    this.store!.set('accounts', accounts)
  }

  /**
   * Update Account
   */
  updateAccount(id: string, updates: Partial<Account>): Account | null {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const index = accounts.findIndex((a: Account) => a.id === id)
    
    if (index === -1) {
      return null
    }
    
    console.log('[Store] Update account:', {
      id,
      updatesCredentials: updates.credentials,
      oldCredentials: accounts[index].credentials,
      oldCredentialsDecrypted: this.decryptCredentials(accounts[index].credentials),
    })
    
    const updatedAccount: Account = {
      ...accounts[index],
      ...updates,
      updatedAt: Date.now(),
    }
    
    if (updates.credentials) {
      updatedAccount.credentials = this.encryptCredentials(updates.credentials)
      console.log('[Store] Encrypted credentials:', updatedAccount.credentials)
      console.log('[Store] Old credentials:', accounts[index].credentials)
      console.log('[Store] Credentials match:', JSON.stringify(updatedAccount.credentials) === JSON.stringify(accounts[index].credentials))
    }
    
    accounts[index] = updatedAccount
    this.store!.set('accounts', accounts)
    
    // Verify save was successful
    const savedAccounts = this.store!.get('accounts') as Account[]
    const savedAccount = savedAccounts.find(a => a.id === id)
    console.log('[Store] Verify after save:', {
      id,
      savedCredentials: savedAccount?.credentials,
    })
    
    return {
      ...updatedAccount,
      credentials: updates.credentials || this.decryptCredentials(accounts[index].credentials),
    }
  }

  /**
   * Delete Account
   */
  deleteAccount(id: string): boolean {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const index = accounts.findIndex((a: Account) => a.id === id)
    
    if (index === -1) {
      return false
    }
    
    accounts.splice(index, 1)
    this.store!.set('accounts', accounts)
    return true
  }

  /**
   * Get Active Accounts
   */
  getActiveAccounts(includeCredentials: boolean = false): Account[] {
    this.ensureInitialized()
    const accounts = this.store!.get('accounts') as Account[] || []
    const active = accounts.filter((a: Account) => a.status === 'active')
    
    if (includeCredentials) {
      return active.map((account: Account) => ({
        ...account,
        credentials: this.decryptCredentials(account.credentials),
      }))
    }
    
    return active
  }

  // ==================== Configuration Operations ====================

  /**
   * Get Application Configuration
   */
  getConfig(): AppConfig {
    this.ensureInitialized()
    return this.normalizeConfig(this.store!.get('config') || DEFAULT_CONFIG)
  }

  /**
   * Applies request-log settings and mirrors the body-logging switch to the
   * content debug logger, so both stay one decision.
   */
  private applyRequestLogConfig(config: RequestLogConfig): void {
    this.requestLogManager?.setConfig(config)
    setContentLoggingEnabled(config.includeBodies)
  }

  /**
   * Mirrors `autoStart` into the OS login item / XDG autostart entry.
   *
   * Runs on every config write that lands here rather than only on
   * `config:update`, because `resetConfig` also changes `autoStart` (default
   * `false`) and would otherwise leave a stale login item behind.
   *
   * Costs nothing when the value did not move: the OS-side write is skipped
   * entirely, so the many unrelated config writes (API keys, mappings, model
   * sync) never touch the registry or the home directory.
   *
   * Failure only warns: a locked-down registry or a read-only home must not
   * turn an unrelated settings save into an error. It does log, because the
   * symptom it prevents ("I enabled it and it never starts") is unobservable
   * otherwise.
   */
  private applyAutoStart(previous: AppConfig | undefined, next: AppConfig): void {
    if (previous !== undefined && previous.autoStart === next.autoStart) return
    void syncAutoStart(next.autoStart).then(result => {
      // `skipped` 的两条都已在 `autostartHost` 里记了日志（开发态 / 无机制平台），
      // 这里不再重复告警；只有真写入时才确认一次，便于用户核对。
      if (result.applied) {
        console.log(`[AutoStart] 开机自启已${next.autoStart ? '开启' : '关闭'}`)
      }
    }).catch((error: unknown) => {
      console.warn(
        '[AutoStart] 写入开机自启失败（不影响使用）：'
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /**
   * Set Application Configuration
   */
  setConfig(config: AppConfig): void {
    this.ensureInitialized()
    const previous = this.getConfig()
    const normalized = this.normalizeConfig(config)
    this.store!.set('config', normalized)
    this.applyRequestLogConfig(normalized.requestLogConfig)
    this.applyAutoStart(previous, normalized)
  }

  /**
   * Update Application Configuration
   */
  updateConfig(updates: Partial<AppConfig>): AppConfig {
    this.ensureInitialized()
    const currentConfig = this.getConfig()
    const newConfig = {
      ...currentConfig,
      ...updates,
    }
    
    // Deep merge for nested objects
    if (updates.toolCallingConfig || updates.toolPromptConfig) {
      const incoming = updates.toolCallingConfig ?? updates.toolPromptConfig
      const incomingRecord = incoming && typeof incoming === 'object' ? incoming as Record<string, unknown> : {}
      const incomingAdvanced = incomingRecord.advanced && typeof incomingRecord.advanced === 'object'
        ? incomingRecord.advanced as Record<string, unknown>
        : {}

      newConfig.toolCallingConfig = normalizeToolCallingConfig({
        ...currentConfig.toolCallingConfig,
        ...incomingRecord,
        advanced: {
          ...currentConfig.toolCallingConfig.advanced,
          ...incomingAdvanced,
        },
      })
      newConfig.toolPromptConfig = undefined
    }
    
    if (updates.sessionConfig && currentConfig.sessionConfig) {
      newConfig.sessionConfig = {
        ...currentConfig.sessionConfig,
        ...updates.sessionConfig,
      }
    }

    if (updates.requestLogConfig) {
      newConfig.requestLogConfig = normalizeRequestLogConfig({
        ...currentConfig.requestLogConfig,
        ...updates.requestLogConfig,
      })
    }

    if (updates.autoRouting) {
      newConfig.autoRouting = normalizeAutoRoutingConfig({
        ...currentConfig.autoRouting,
        ...updates.autoRouting,
      })
    }

    const normalized = this.normalizeConfig(newConfig)
    this.store!.set('config', normalized)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(normalized))
    this.applyRequestLogConfig(normalized.requestLogConfig)
    this.applyAutoStart(currentConfig, normalized)
    return normalized
  }

  /**
   * Reset Configuration to Default Values
   */
  resetConfig(): AppConfig {
    this.ensureInitialized()
    const previous = this.getConfig()
    this.store!.set('config', DEFAULT_CONFIG)
    this.appLogManager?.setMaxEntries(this.getMaxLogEntries(DEFAULT_CONFIG))
    this.applyRequestLogConfig(DEFAULT_CONFIG.requestLogConfig)
    this.applyAutoStart(previous, DEFAULT_CONFIG)
    return DEFAULT_CONFIG
  }

  // ==================== Log Operations ====================

  /**
   * Add Log Entry
   */
  addLog(
    level: LogLevel,
    message: string,
    data?: {
      accountId?: string
      providerId?: string
      requestId?: string
      deletedAccounts?: number
      data?: Record<string, unknown>
      model?: string
      actualModel?: string
      latency?: number
      isStream?: boolean
      error?: string
    }
  ): LogEntry {
    this.ensureInitialized()
    const entry: LogEntry = {
      id: this.generateId(),
      timestamp: Date.now(),
      level,
      message,
      ...data,
    }

    if (!this.shouldRecordLog(level)) {
      return entry
    }

    this.getAppLogManager().addLog(entry)

    return entry
  }

  /**
   * Get Logs
   * @param limit Limit count
   * @param level Log level filter
   */
  getLogs(filter?: AppLogFilter): LogEntry[] {
    this.ensureInitialized()
    return this.getAppLogManager().getLogs(filter)
  }

  /**
   * Clear Logs
   */
  clearLogs(): void {
    this.ensureInitialized()
    this.getAppLogManager().clearLogs()
    this.store!.set('logs', [])
  }

  replaceLogs(logs: LogEntry[]): void {
    this.ensureInitialized()
    this.getAppLogManager().replaceLogs(logs)
    this.store!.set('logs', [])
  }

  /**
   * Get Log Statistics
   */
  getLogStats(): { total: number; info: number; warn: number; error: number; debug: number } {
    this.ensureInitialized()
    return this.getAppLogManager().getStats()
  }

  /**
   * Get Log Trend
   */
  getLogTrend(days: number = 7): AppLogTrendPoint[] {
    this.ensureInitialized()
    return this.getAppLogManager().getTrend(days)
  }

  /**
   * Get Log Trend for specific account
   * Only counts successful API requests (logs with requestId) to match requestCount
   */
  getAccountLogTrend(accountId: string, days: number = 7): AppLogTrendPoint[] {
    this.ensureInitialized()
    return this.getAppLogManager().getAccountTrend(accountId, days)
  }

  /**
   * Export Logs
   */
  exportLogs(format: 'json' | 'txt' = 'json'): string {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()

    if (format === 'json') {
      return JSON.stringify(logs, null, 2)
    }

    return logs
      .map((log: LogEntry) => {
        const time = new Date(log.timestamp).toISOString()
        const level = log.level.toUpperCase().padEnd(5)
        let line = `[${time}] [${level}] ${log.message}`
        
        if (log.providerId) {
          line += ` | Provider: ${log.providerId}`
        }
        if (log.accountId) {
          line += ` | Account: ${log.accountId}`
        }
        if (log.requestId) {
          line += ` | Request: ${log.requestId}`
        }
        if (log.data) {
          line += ` | Data: ${JSON.stringify(log.data)}`
        }
        
        return line
      })
      .join('\n')
  }

  /**
   * Get Log By ID
   */
  getLogById(id: string): LogEntry | undefined {
    this.ensureInitialized()
    const logs = this.getCombinedLogs()
    return logs.find((l: LogEntry) => l.id === id)
  }

  /**
   * Clear Expired Logs
   */
  cleanExpiredLogs(): void {
    this.ensureInitialized()
    const config = this.getConfig()
    const logs = this.getCombinedLogs()
    const cutoff = Date.now() - config.logRetentionDays * 24 * 60 * 60 * 1000
    
    const filtered = logs.filter((l: LogEntry) => l.timestamp >= cutoff)
    this.getAppLogManager().replaceLogs(filtered)
    this.store!.set('logs', [])
  }

  // ==================== Request Log Operations ====================

  /**
   * Add Request Log Entry
   */
  addRequestLog(entry: Omit<RequestLogEntry, 'id'>): RequestLogEntry {
    this.ensureInitialized()
    const newEntry = this.getRequestLogManager().addRequestLog(entry)
    // A disabled log or a zero cap stores nothing, and a row the disk does not
    // have must not reach the list either.
    const logConfig = this.getConfig().requestLogConfig
    if (logConfig.enabled && logConfig.maxEntries > 0) {
      sendRequestLog(this.mainWindow, newEntry)
    }
    return newEntry
  }

  /**
   * Update Request Log Entry
   */
  updateRequestLog(id: string, updates: Partial<RequestLogEntry>): boolean {
    this.ensureInitialized()
    return this.getRequestLogManager().updateRequestLog(id, updates)
  }

  /**
   * Get Request Logs
   */
  getRequestLogs(limit?: number, filter?: { status?: 'success' | 'error'; providerId?: string }): RequestLogEntry[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogs(limit, filter)
  }

  /**
   * Get Request Log By ID
   */
  getRequestLogById(id: string): RequestLogEntry | undefined {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogById(id)
  }

  /**
   * Clear Request Logs
   */
  clearRequestLogs(): void {
    this.ensureInitialized()
    this.getRequestLogManager().clearRequestLogs()
    this.store!.set('statistics', DEFAULT_STATISTICS)
  }

  /**
   * Get Request Log Statistics
   */
  getRequestLogStats(): { total: number; success: number; error: number; todayTotal: number; todaySuccess: number; todayError: number } {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogStats()
  }

  /**
   * Get Request Log Trend
   */
  getRequestLogTrend(days: number = 7): RequestLogTrendPoint[] {
    this.ensureInitialized()
    return this.getRequestLogManager().getRequestLogTrend(days)
  }

  // ==================== Statistics Operations ====================

  /**
   * Get Persistent Statistics
   */
  getStatistics(): PersistentStatistics {
    this.ensureInitialized()
    return this.store!.get('statistics') || DEFAULT_STATISTICS
  }

  /**
   * Update Statistics
   */
  updateStatistics(updates: Partial<PersistentStatistics>): PersistentStatistics {
    this.ensureInitialized()
    const currentStats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const newStats = {
      ...currentStats,
      ...updates,
      lastUpdated: Date.now(),
    }
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Record Request in Statistics
   */
  recordRequestInStats(
    success: boolean,
    latency: number,
    model?: string,
    providerId?: string,
    accountId?: string
  ): PersistentStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const today = localDayKey(Date.now())
    
    const newStats: PersistentStatistics = {
      ...stats,
      totalRequests: stats.totalRequests + 1,
      successRequests: success ? stats.successRequests + 1 : stats.successRequests,
      failedRequests: success ? stats.failedRequests : stats.failedRequests + 1,
      totalLatency: success ? stats.totalLatency + latency : stats.totalLatency,
      lastUpdated: Date.now(),
      modelUsage: { ...stats.modelUsage },
      providerUsage: { ...stats.providerUsage },
      accountUsage: { ...stats.accountUsage },
      dailyStats: { ...stats.dailyStats },
    }
    
    if (model) {
      newStats.modelUsage[model] = (newStats.modelUsage[model] || 0) + 1
    }
    
    if (providerId) {
      newStats.providerUsage[providerId] = (newStats.providerUsage[providerId] || 0) + 1
    }
    
    if (accountId) {
      newStats.accountUsage[accountId] = (newStats.accountUsage[accountId] || 0) + 1
    }
    
    if (!newStats.dailyStats[today]) {
      newStats.dailyStats[today] = {
        date: today,
        totalRequests: 0,
        successRequests: 0,
        failedRequests: 0,
        totalLatency: 0,
        modelUsage: {},
        providerUsage: {},
      }
    }
    
    newStats.dailyStats[today].totalRequests++
    if (success) {
      newStats.dailyStats[today].successRequests++
      newStats.dailyStats[today].totalLatency += latency
    } else {
      newStats.dailyStats[today].failedRequests++
    }
    
    if (model) {
      newStats.dailyStats[today].modelUsage[model] = (newStats.dailyStats[today].modelUsage[model] || 0) + 1
    }
    
    if (providerId) {
      newStats.dailyStats[today].providerUsage[providerId] = (newStats.dailyStats[today].providerUsage[providerId] || 0) + 1
    }
    
    this.store!.set('statistics', newStats)
    return newStats
  }

  /**
   * Get Today Statistics
   */
  getTodayStatistics(): DailyStatistics {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const today = localDayKey(Date.now())
    return stats.dailyStats[today] || {
      date: today,
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalLatency: 0,
      modelUsage: {},
      providerUsage: {},
    }
  }

  /**
   * Record one request's token usage into today's bucket.
   *
   * Kept apart from `recordRequestInStats` on purpose: that one is a per-request
   * counter, this one must preserve the upstream/estimate split and is bounded
   * per day. Sharing one write would couple two unrelated retention rules.
   */
  recordTokenUsage(input: {
    promptTokens: number
    completionTokens: number
    source: 'upstream' | 'estimated'
    savedTokens?: number
    /** 上游报的缓存命中输入 token；只在 `source === 'upstream'` 时入池。 */
    cacheReadTokens?: number
    nowMs?: number
  }): void {
    this.ensureInitialized()
    const day = tokenDayKey(input.nowMs ?? Date.now())
    const stored = this.store!.get('tokenUsage') ?? {}
    const next = accumulateDayBucket(stored[day], input)
    // Trim by day count so a long install cannot grow this key forever.
    this.store!.set('tokenUsage', trimDays({ ...stored, [day]: next }))
  }

  /** Today's token summary, or an all-zero bucket when nothing was recorded. */
  getTodayTokenUsage(nowMs: number = Date.now()): DayTokenSummary {
    this.ensureInitialized()
    const day = tokenDayKey(nowMs)
    const stored = this.store!.get('tokenUsage') ?? {}
    return summarizeDay(day, normalizeDayBucket(stored[day]))
  }

  /** Token summaries for the newest `days` local days, oldest first. */
  getTokenUsageHistory(days: number = 7, nowMs: number = Date.now()): DayTokenSummary[] {
    this.ensureInitialized()
    const stored = this.store!.get('tokenUsage') ?? {}
    return recentLocalDays(days, nowMs).map(window =>
      summarizeDay(window.key, normalizeDayBucket(stored[window.key]))
    )
  }

  /**
   * Clean Old Daily Statistics (older than 30 days)
   */
  cleanOldDailyStats(): void {
    this.ensureInitialized()
    const stats = this.store!.get('statistics') || DEFAULT_STATISTICS
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const cutoffDate = localDayKey(cutoff)
    
    const filteredDailyStats: Record<string, DailyStatistics> = {}
    for (const [date, dayStats] of Object.entries(stats.dailyStats)) {
      if (date >= cutoffDate) {
        filteredDailyStats[date] = dayStats as DailyStatistics
      }
    }
    
    if (Object.keys(filteredDailyStats).length !== Object.keys(stats.dailyStats).length) {
      stats.dailyStats = filteredDailyStats
      this.store!.set('statistics', stats)
    }
  }

  // ==================== System Prompts Operations ====================

  // ==================== Session Operations ====================

  /**
   * Get Session Configuration
   */
  getSessionConfig(): SessionConfig {
    this.ensureInitialized()
    const config = this.store!.get('config') || DEFAULT_CONFIG
    return config.sessionConfig || DEFAULT_SESSION_CONFIG
  }

  /**
   * Update Session Configuration
   */
  updateSessionConfig(updates: Partial<SessionConfig>): SessionConfig {
    this.ensureInitialized()
    const currentConfig = this.store!.get('config') || DEFAULT_CONFIG
    const newSessionConfig = {
      ...(currentConfig.sessionConfig || DEFAULT_SESSION_CONFIG),
      ...updates,
    }
    const newConfig = {
      ...currentConfig,
      sessionConfig: newSessionConfig,
    }
    this.store!.set('config', newConfig)
    return newSessionConfig
  }

  /**
   * Get All Sessions
   */
  getSessions(): SessionRecord[] {
    this.ensureInitialized()
    return this.store!.get('sessions') || []
  }

  /**
   * Get Session By ID
   */
  getSessionById(id: string): SessionRecord | undefined {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.find((s: SessionRecord) => s.id === id)
  }

  /**
   * Get Active Sessions
   */
  getActiveSessions(): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    return sessions.filter((s: SessionRecord) => 
      s.status === 'active' && 
      (now - s.lastActiveAt) < timeoutMs
    )
  }

  /**
   * Add Session
   */
  addSession(session: SessionRecord): void {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    sessions.push(session)
    this.store!.set('sessions', sessions)
  }

  /**
   * Update Session
   */
  updateSession(id: string, updates: Partial<SessionRecord>): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return null
    }
    
    sessions[index] = {
      ...sessions[index],
      ...updates,
    }
    
    this.store!.set('sessions', sessions)
    return sessions[index]
  }

  /**
   * Add Message to Session
   */
  addMessageToSession(sessionId: string, message: ChatMessage): SessionRecord | null {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === sessionId)
    
    if (index === -1) {
      return null
    }
    
    const config = this.getSessionConfig()
    const session = sessions[index]
    
    if (session.messages.length >= config.maxMessagesPerSession) {
      session.messages = session.messages.slice(-config.maxMessagesPerSession + 1)
    }
    
    session.messages.push(message)
    session.lastActiveAt = Date.now()
    
    sessions[index] = session
    this.store!.set('sessions', sessions)
    return session
  }

  /**
   * Delete Session
   */
  deleteSession(id: string): boolean {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const index = sessions.findIndex((s: SessionRecord) => s.id === id)
    
    if (index === -1) {
      return false
    }
    
    sessions.splice(index, 1)
    this.store!.set('sessions', sessions)
    return true
  }

  /**
   * Mark Session as Expired
   */
  expireSession(id: string): SessionRecord | null {
    return this.updateSession(id, { status: 'expired' })
  }

  /**
   * Clean Expired Sessions
   * Always delete sessions with 'expired' status
   * For timed-out active sessions, behavior depends on deleteAfterTimeout config:
   * - If true: Delete them from storage
   * - If false: Mark them as 'expired' (will be deleted on next clean)
   */
  cleanExpiredSessions(): number {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    const config = this.getSessionConfig()
    const timeoutMs = config.sessionTimeout * 60 * 1000
    const now = Date.now()
    
    let removedCount = 0
    
    // Always delete sessions that are already expired
    let remainingSessions = sessions.filter((s: SessionRecord) => {
      if (s.status === 'expired') {
        removedCount++
        return false
      }
      return true
    })
    
    // Handle timed-out active sessions based on config
    if (config.deleteAfterTimeout) {
      // Delete timed-out sessions from storage
      remainingSessions = remainingSessions.filter((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return false
        }
        return true
      })
    } else {
      // Mark timed-out sessions as expired (will be deleted on next clean)
      remainingSessions = remainingSessions.map((s: SessionRecord) => {
        if (s.status === 'active' && (now - s.lastActiveAt) >= timeoutMs) {
          removedCount++
          return { ...s, status: 'expired' as const }
        }
        return s
      })
    }
    
    this.store!.set('sessions', remainingSessions)
    
    return removedCount
  }

  /**
   * Get Sessions By Account ID
   */
  getSessionsByAccountId(accountId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.accountId === accountId)
  }

  /**
   * Get Sessions By Provider ID
   */
  getSessionsByProviderId(providerId: string): SessionRecord[] {
    this.ensureInitialized()
    const sessions = this.store!.get('sessions') || []
    return sessions.filter((s: SessionRecord) => s.providerId === providerId)
  }

  /**
   * Clear All Sessions
   */
  clearAllSessions(): void {
    this.ensureInitialized()
    this.store!.set('sessions', [])
  }

  // ==================== Model Management Operations ====================

  /**
   * Get User Model Overrides
   */
  private getUserModelOverrides(): UserModelOverrides {
    this.ensureInitialized()
    return this.store!.get('userModelOverrides') || DEFAULT_USER_MODEL_OVERRIDES
  }

  /**
   * Set User Model Overrides
   */
  private setUserModelOverrides(overrides: UserModelOverrides): void {
    this.ensureInitialized()
    this.store!.set('userModelOverrides', overrides)
  }

  /**
   * Get Provider Model Overrides
   */
  private getProviderModelOverrides(providerId: string): ProviderModelOverrides {
    const overrides = this.getUserModelOverrides()
    return overrides[providerId] || {
      addedModels: [],
      excludedModels: [],
    }
  }

  /**
   * Get Effective Models for a Provider
   * Merges default models with user overrides
   */
  /**
   * The whole catalogue with each row's served flag, so the management page can
   * list a stopped model instead of losing it.
   */
  getModelCatalogue(providerId: string): CatalogueModel[] {
    this.ensureInitialized()

    const provider = this.getProviderById(providerId)
    if (!provider) {
      return []
    }

    return buildModelCatalogue(
      provider.supportedModels || [],
      provider.modelMappings || {},
      this.getProviderModelOverrides(providerId)
    )
  }

  /**
   * Get Effective Models for a Provider
   * The served slice of the catalogue: what `/v1/models` advertises and what the
   * load balancer routes, so advertising and routing cannot disagree.
   */
  getEffectiveModels(providerId: string): EffectiveModel[] {
    return this.getModelCatalogue(providerId)
      .filter(model => model.served)
      .map(model => ({
        displayName: model.displayName,
        actualModelId: model.actualModelId,
        isCustom: model.isCustom,
        source: model.source,
      }))
  }

  /**
   * Start or stop a batch of catalogue models for one provider.
   */
  setModelsServed(providerId: string, names: string[], served: boolean): CatalogueModel[] {
    this.ensureInitialized()

    if (!this.getProviderById(providerId)) {
      throw new Error('Provider not found')
    }

    if (names.length === 0) {
      return this.getModelCatalogue(providerId)
    }

    const overrides = this.getUserModelOverrides()
    const current: ProviderModelOverrides = overrides[providerId] || {
      addedModels: [],
      excludedModels: [],
    }
    this.setUserModelOverrides({
      ...overrides,
      [providerId]: {
        ...current,
        excludedModels: applyServed(current.excludedModels || [], names, served),
      },
    })

    return this.getModelCatalogue(providerId)
  }

  /**
   * Store a freshly fetched online model list for a provider
   */
  applyFetchedModels(
    providerId: string,
    models: FetchedModel[]
  ): { fetchedCount: number; addedCount: number; fetchedAt: number; effectiveModels: EffectiveModel[] } {
    this.ensureInitialized()

    const before = new Set(this.getEffectiveModels(providerId).map(model => model.displayName))
    const overrides = this.getUserModelOverrides()

    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const fetchedAt = Date.now()
    overrides[providerId].fetchedModels = models.map(model => ({
      displayName: model.displayName,
      actualModelId: model.actualModelId,
    }))
    overrides[providerId].fetchedAt = fetchedAt
    this.setUserModelOverrides(overrides)

    const effectiveModels = this.getEffectiveModels(providerId)
    const addedCount = effectiveModels.filter(model => !before.has(model.displayName)).length

    return { fetchedCount: models.length, addedCount, fetchedAt, effectiveModels }
  }

  /**
   * Add Custom Model to Provider
   */
  addCustomModel(providerId: string, model: CustomModel): EffectiveModel[] {
    this.ensureInitialized()
    
    const overrides = this.getUserModelOverrides()
    
    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const existingModel = overrides[providerId].addedModels.find(
      m => m.displayName === model.displayName || m.actualModelId === model.actualModelId
    )
    
    if (existingModel) {
      throw new Error(`Model with display name "${model.displayName}" or actual ID "${model.actualModelId}" already exists`)
    }

    overrides[providerId].addedModels.push(model)
    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Remove Model from Provider
   * For default models: add to excludedModels
   * For custom models: remove from addedModels
   */
  removeModel(providerId: string, modelName: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const provider = this.getProviderById(providerId)
    if (!provider) {
      throw new Error('Provider not found')
    }

    const overrides = this.getUserModelOverrides()
    
    if (!overrides[providerId]) {
      overrides[providerId] = {
        addedModels: [],
        excludedModels: [],
      }
    }

    const defaultModels = provider.supportedModels || []
    const isDefaultModel = defaultModels.includes(modelName)

    if (isDefaultModel) {
      if (!overrides[providerId].excludedModels.includes(modelName)) {
        overrides[providerId].excludedModels.push(modelName)
      }
    } else {
      overrides[providerId].addedModels = overrides[providerId].addedModels.filter(
        m => m.displayName !== modelName
      )
      // Otherwise deleting a row that came from the last online sync would do nothing
      overrides[providerId].fetchedModels = (overrides[providerId].fetchedModels || []).filter(
        m => m.displayName !== modelName
      )
    }

    this.setUserModelOverrides(overrides)

    return this.getEffectiveModels(providerId)
  }

  /**
   * Reset Provider Models to Default
   * Removes all user overrides for the provider
   */
  resetModels(providerId: string): EffectiveModel[] {
    this.ensureInitialized()
    
    const overrides = this.getUserModelOverrides()
    
    if (overrides[providerId]) {
      delete overrides[providerId]
      this.setUserModelOverrides(overrides)
    }

    const builtinConfig = BUILTIN_PROVIDERS.find(provider => provider.id === providerId)
    if (builtinConfig) {
      const providers = (this.store!.get('providers') as Provider[] || []).map(provider => {
        if (provider.id !== providerId || provider.type !== 'builtin') {
          return provider
        }

        return {
          ...provider,
          apiEndpoint: builtinConfig.apiEndpoint,
          chatPath: builtinConfig.chatPath,
          supportedModels: builtinConfig.supportedModels,
          modelMappings: builtinConfig.modelMappings,
          headers: builtinConfig.headers,
          credentialFields: builtinConfig.credentialFields,
          description: builtinConfig.description,
          updatedAt: Date.now(),
        }
      })
      this.store!.set('providers', providers)
    }

    return this.getEffectiveModels(providerId)
  }

  // ==================== Utility Methods ====================

  /**
   * Generate Unique ID
   */
  generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * Get Storage Instance (for internal use only)
   */
  getStore(): StoreType | null {
    return this.store
  }

  /**
   * Clear All Data
   */
  clearAll(): void {
    this.ensureInitialized()
    this.appLogManager?.clearLogs()
    this.appLogManager?.flushSync()
    this.store!.clear()
    this.requestLogManager?.clearRequestLogs()
    this.requestLogManager?.flushSync()
  }

  /**
   * Get Storage Path
   */
  getStorePath(): string {
    return this.getStoragePath()
  }

  getQuotaLedger(): QuotaLedger {
    if (!this.quotaLedger) {
      throw new Error('Quota ledger is not initialized')
    }
    return this.quotaLedger
  }

  private getRequestLogManager(): RequestLogManager {
    if (!this.requestLogManager) {
      throw new Error('Request log manager is not initialized')
    }
    return this.requestLogManager
  }

  private getAppLogManager(): AppLogManager {
    if (!this.appLogManager) {
      throw new Error('App log manager is not initialized')
    }
    return this.appLogManager
  }
}

// Export singleton instance
export const storeManager = new StoreManager()

// Export types
export type { StoreType }
