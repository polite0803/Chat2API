import axios, { AxiosError } from 'axios'
import { getBuiltinProvider } from './builtin/index.ts'
import { opencodeService } from '../opencode/service.ts'
import { resolveOpencodeLauncher } from '../opencode/runtime.ts'
import { channelRuntimeState } from './accountChannels/runtimeState.ts'
import type { Provider, ProviderCheckResult, Account } from '../../shared/types'
import type { BuiltinProviderConfig } from '../store/types'

const CHECK_TIMEOUT = 15000

export interface TokenCheckResult {
  valid: boolean
  error?: string
  userInfo?: {
    name?: string
    email?: string
    quota?: number
    used?: number
  }
}

export class ProviderChecker {
  static async checkProviderStatus(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const builtinConfig = provider.type === 'builtin' 
        ? getBuiltinProvider(provider.id) 
        : null
      
      if (builtinConfig) {
        if (builtinConfig.runtimeModels) {
          return this.checkRuntimeProvider(builtinConfig)
        }
        return await this.checkBuiltinProvider(builtinConfig)
      }

      // 账号渠道同样没有可探的 HTTP 端点（apiEndpoint 是 `channel://` 占位），
      // 拿它发请求只会得到 axios 的「Unsupported protocol channel:」。这里只报
      // Worker 是否已经在跑，绝不因为一次状态检查去拉起它。
      if (provider.type === 'account') {
        const running = channelRuntimeState.running
        return {
          providerId: provider.id,
          status: running ? 'online' : 'unknown',
          latency: 0,
          reason: running ? 'channel_runtime_running' : 'channel_runtime_stopped',
        }
      }

      return await this.checkCustomProvider(provider)
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private static async checkBuiltinProvider(config: BuiltinProviderConfig): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const checkUrl = `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint || '/health'}`
      
      const response = await axios({
        method: 'GET',
        url: checkUrl,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: config.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: config.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  /**
   * 本机运行时供应商没有 HTTP 端点可探：apiEndpoint 只是占位 scheme，
   * 拿它去发 HTTP 就是 axios 的 "Unsupported protocol opencode:"。
   * 这里只报"运行时现在是不是已经在跑"——状态检查不该顺手把运行时拉起来，
   * 那要几十秒，而首次请求本来就会自动拉起。
   */
  private static checkRuntimeProvider(config: BuiltinProviderConfig): ProviderCheckResult {
    const state = opencodeService.getState()

    if (state.running) {
      return {
        providerId: config.id,
        status: 'online',
        latency: 0,
        reason: 'runtime_running',
      }
    }

    if (state.lastError) {
      return {
        providerId: config.id,
        status: 'offline',
        latency: 0,
        reason: 'runtime_failed',
        error: state.lastError,
      }
    }

    // 装没装是两回事：没装的话首次使用要走 npx 下载，得多等一会儿
    const installed = resolveOpencodeLauncher().source !== 'npx fallback'

    return {
      providerId: config.id,
      status: 'unknown',
      latency: 0,
      reason: installed ? 'runtime_not_running' : 'runtime_not_installed',
    }
  }

  private static async checkCustomProvider(provider: Provider): Promise<ProviderCheckResult> {
    const startTime = Date.now()
    
    try {
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers: provider.headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      const latency = Date.now() - startTime
      
      if (response.status >= 200 && response.status < 500) {
        return {
          providerId: provider.id,
          status: 'online',
          latency,
        }
      }
      
      return {
        providerId: provider.id,
        status: 'offline',
        latency,
        error: `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        providerId: provider.id,
        status: 'offline',
        latency: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Connection failed',
      }
    }
  }

  static async checkAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    const builtinConfig = provider.type === 'builtin' 
      ? getBuiltinProvider(provider.id) 
      : null
    
    if (!builtinConfig) {
      return this.checkCustomAccountToken(provider, account)
    }
    
    if (!builtinConfig.tokenCheckEndpoint) {
      return { valid: true }
    }
    return this.checkGenericToken(builtinConfig, account)
  }

  private static async checkGenericToken(
    config: BuiltinProviderConfig,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...config.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: config.tokenCheckMethod || 'GET',
        url: `${config.apiEndpoint.replace('/api', '')}${config.tokenCheckEndpoint}`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

  private static async checkCustomAccountToken(
    provider: Provider,
    account: Account
  ): Promise<TokenCheckResult> {
    try {
      const headers: Record<string, string> = {
        ...provider.headers,
      }
      
      const credentials = account.credentials
      if (credentials.token) {
        headers['Authorization'] = `Bearer ${credentials.token}`
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`
      }
      
      const response = await axios({
        method: 'GET',
        url: `${provider.apiEndpoint}/models`,
        headers,
        timeout: CHECK_TIMEOUT,
        validateStatus: () => true,
      })
      
      if (response.status >= 200 && response.status < 300) {
        return { valid: true }
      }
      
      if (response.status === 401) {
        return { valid: false, error: 'Authentication failed, please check credentials' }
      }
      
      return { valid: false, error: `Validation failed: HTTP ${response.status}` }
    } catch (error) {
      return {
        valid: false,
        error: error instanceof AxiosError 
          ? error.message 
          : 'Connection failed',
      }
    }
  }

}

export default ProviderChecker
