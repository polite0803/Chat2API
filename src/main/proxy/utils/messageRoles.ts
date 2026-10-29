import type { ChatMessage } from '../types'

/**
 * `developer` 是 OpenAI 新版对 `system` 的别名（推理模型客户端普遍改用它）。
 *
 * 但下游没有一处认识它：渠道包网关只认 system / user / assistant / tool，
 * 见到别的角色直接 400 `unsupported message role: developer`；Anthropic wire 则
 * 会把不认识的角色静默降级成 user，让开发者指令混进用户正文。故在入口折成
 * `system`，让所有上游看到同一份语义，而不是逐家打补丁。
 */
export function normalizeMessageRoles(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if ((message as { role?: string }).role !== 'developer') return message
    return { ...message, role: 'system' }
  })
}
