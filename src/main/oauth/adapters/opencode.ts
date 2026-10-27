/**
 * OpenCode Authentication Adapter
 *
 * 免费池不需要凭据：请求由本机 OpenCode 运行时带着它自己的隔离状态完成，不涉及账号/密钥。
 * 这个 adapter 只把"空凭据"判为有效，不发任何网络请求。
 */

import { shell } from 'electron'
import { BaseOAuthAdapter } from './base'
import { OAuthResult, OAuthOptions, TokenValidationResult, AdapterConfig } from '../types'

const OPENCODE_HOME = 'https://opencode.ai'

export class OpenCodeAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'opencode',
      authMethods: ['manual'],
      loginUrl: OPENCODE_HOME,
      apiUrl: OPENCODE_HOME,
    })
  }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    await shell.openExternal(OPENCODE_HOME)
    return {
      success: false,
      providerId: options.providerId,
      error: 'OpenCode 免费池不需要登录：直接添加账号即可（首次请求会自动启动本机 OpenCode 运行时）',
    }
  }

  async validateToken(): Promise<TokenValidationResult> {
    return { valid: true, tokenType: 'access' }
  }

  async refreshToken(): Promise<null> {
    return null
  }
}

export default OpenCodeAdapter
