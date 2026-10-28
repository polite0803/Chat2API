/**
 * OAuth Adapter Index
 * The only provider that authenticates through a host flow is the OpenCode
 * runtime; the web-page adapters were retired with their providers.
 */

export { BaseOAuthAdapter } from './base'
export { OpenCodeAdapter } from './opencode'
import { BaseOAuthAdapter } from './base'
import { OpenCodeAdapter } from './opencode'
import { ProviderType, AdapterConfig } from '../types'

/**
 * Adapter factory function
 */
export function createAdapter(
  providerType: ProviderType,
  config: AdapterConfig
): BaseOAuthAdapter {
  switch (providerType) {
    case 'opencode':
      return new OpenCodeAdapter(config)
    default:
      throw new Error(`Unsupported provider type: ${providerType}`)
  }
}

/**
 * Get supported authentication methods for provider
 */
export function getSupportedAuthMethods(providerType: ProviderType): string[] {
  switch (providerType) {
    case 'opencode':
      return ['manual']
    default:
      return ['manual']
  }
}
