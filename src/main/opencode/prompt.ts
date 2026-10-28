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

/**
 * 我们这条通路只吃文本。图片等附件必须**明确报错**：
 * 悄悄丢掉会让客户端以为模型"看过图了"，那是在拿假结果当正常结果。
 */
export class UnsupportedContentError extends Error {
  readonly code = 'unsupported_content'
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedContentError'
  }
}

const IMAGE_TYPES = new Set(['image_url', 'input_image', 'image'])

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        const value = part as { type?: string; text?: string }
        if (value.type === 'text' && typeof value.text === 'string') return value.text
        if (value.type && IMAGE_TYPES.has(value.type)) {
          throw new UnsupportedContentError(
            'OpenCode 提供商当前不支持图片输入，请改用支持视觉的模型或提供商',
          )
        }
        if (value.type) {
          throw new UnsupportedContentError(`不支持的消息内容类型: ${value.type}`)
        }
        return ''
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
