import type { NormalizedToolResult, ToolProtocolId } from './types.ts'
import { managedXmlProtocol } from './protocols/managedXml.ts'

export interface ProviderToolProfile {
  providerId: string
  managedSupport: boolean
  supportsNativeTools: boolean
  /** 上游自己把工具调用翻好了（OpenCode 的信封协议），托管层必须完全不碰 */
  handlesToolsItself?: boolean
  preferredManagedProtocol: ToolProtocolId
  formatAssistantToolCalls(calls: Array<{ id: string; name: string; arguments: string }>): string
  formatToolResult(result: NormalizedToolResult): string
}

const chat2ApiXmlHistoryProfile: Omit<ProviderToolProfile, 'providerId'> = {
  managedSupport: true,
  supportsNativeTools: false,
  preferredManagedProtocol: 'managed_xml',
  formatAssistantToolCalls(calls) {
    return managedXmlProtocol.formatAssistantToolCalls(calls)
  },
  formatToolResult(result) {
    return managedXmlProtocol.formatToolResult(result)
  },
}

const profiles: Record<string, ProviderToolProfile> = {
  opencode: {
    providerId: 'opencode',
    managedSupport: false,
    supportsNativeTools: true,
    handlesToolsItself: true,
    preferredManagedProtocol: 'managed_xml',
    formatAssistantToolCalls(calls) {
      return managedXmlProtocol.formatAssistantToolCalls(calls)
    },
    formatToolResult(result) {
      return managedXmlProtocol.formatToolResult(result)
    },
  },
}

export function getProviderToolProfile(providerId: string): ProviderToolProfile {
  return profiles[providerId] ?? {
    providerId,
    ...chat2ApiXmlHistoryProfile,
  }
}
