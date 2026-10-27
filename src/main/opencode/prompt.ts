/**
 * 把我们这边的 OpenAI 消息数组压成 OpenCode 能吃的"一段文本 + 一句系统指令"。
 *
 * OpenCode 是 agent：它的入口是 prompt，不是 messages 数组。所以这里把整段对话渲染成带角色
 * 标记的转录，并明确要求它只回最后一条用户消息的答复，避免它输出计划/工具摘要。
 */

export interface TranscriptMessage {
  role: string
  content: unknown
  name?: string
  tool_call_id?: string
  tool_calls?: unknown
}

const ROLES: Record<string, string> = {
  system: 'system',
  developer: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        const value = part as { type?: string; text?: string }
        return value.type === 'text' && typeof value.text === 'string' ? value.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content == null ? '' : JSON.stringify(content)
}

export function renderTranscript(messages: TranscriptMessage[]): string {
  const lines: string[] = [
    'You are answering as the assistant inside an external chat application.',
    'Below is the conversation so far. Reply with the assistant response to the final user message.',
    'Output only that reply: no plan, no tool summary, no preamble about your environment.',
    '',
  ]

  for (const message of messages) {
    const label = message.role === 'tool'
      ? `tool${message.tool_call_id ? `:${message.tool_call_id}` : ''}`
      : (ROLES[message.role] ?? message.role)
    const text = textOf(message.content)
    if (!text.trim()) continue
    lines.push(`[${label}]`, text, '')
  }

  lines.push('[assistant]')
  return lines.join('\n')
}
